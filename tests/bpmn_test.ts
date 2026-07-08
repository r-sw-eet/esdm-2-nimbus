import { assert, assertEquals } from '@std/assert';
import { parseBpmn } from '../src/bpmn/bpmnParser.ts';
import { mapBpmnToEsdm } from '../src/bpmn/bpmnToEsdm.ts';

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
    xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:esdm="https://esdm-extensions.io/bpmn">
  <bpmn:extensionElements>
    <esdm:meta domain="widgets"/>
  </bpmn:extensionElements>
  <bpmn:process id="Process_w" name="Widgets">
    <bpmn:extensionElements>
      <esdm:meta context="widgets" aggregate="widget"/>
    </bpmn:extensionElements>
    <bpmn:startEvent id="s"/>
    <bpmn:userTask id="t_create" name="create widget">
      <bpmn:extensionElements>
        <esdm:meta state="created"/>
        <esdm:field name="quantity" type="integer"/>
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:serviceTask id="t_ship" name="ship widget">
      <bpmn:extensionElements>
        <esdm:meta state="shipped"/>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="t_create"/>
    <bpmn:sequenceFlow id="f1" sourceRef="t_create" targetRef="t_ship">
      <bpmn:conditionExpression>\${quantity &gt;= 1}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f2" sourceRef="t_ship" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;

const find = (docs: Record<string, unknown>[], kind: string, name: string): Record<string, unknown> => {
    const doc = docs.find((d) => d.kind === kind && d.name === name);
    assert(doc !== undefined, `expected a ${kind} named ${name}`);

    return doc;
};

Deno.test('parses BPMN namespace-agnostically and preserves document order', () => {
    const parsed = parseBpmn(BPMN);
    assertEquals(parsed.domain, 'widgets');
    assertEquals(parsed.processes.length, 1);
    const process = parsed.processes[0];
    assertEquals(process.context, 'widgets');
    assertEquals(process.aggregate, 'widget');
    // startEvent, two tasks, endEvent — kept in document order (mixed subtypes).
    assertEquals([...process.nodes.values()].map((n) => n.id), ['s', 't_create', 't_ship', 'e']);
    // camunda ${...} wrapper stripped from the guard.
    assertEquals(process.flows.find((f) => f.id === 'f1')?.condition, 'quantity >= 1');
});

Deno.test('maps a pool to core + state machine (proposal 0003)', () => {
    const { domain, documents, stateMachines } = mapBpmnToEsdm(parseBpmn(BPMN), 'fallback');
    assertEquals(domain, 'widgets');

    // A create command carries no id and pins its lifecycle annotation.
    const create = find(documents, 'command', 'create-widget');
    assertEquals(create.metadata, { annotations: { 'esdm-extensions.io/lifecycle': 'create' } });
    assertEquals((create.data as { required: string[] }).required, ['quantity']);
    assertEquals(create.publishes, ['widget-created']);

    // A mutate command carries the aggregate id.
    const ship = find(documents, 'command', 'ship-widget');
    assertEquals((ship.data as { required: string[] }).required, ['id']);
    assertEquals(ship.publishes, ['widget-shipped']);

    // The event derives its past-participle name and pins the resulting status.
    const created = find(documents, 'event', 'widget-created');
    assertEquals((created.data as { properties: Record<string, unknown> }).properties.status, {
        type: 'string',
        default: 'created',
    });

    // One state machine: created (transient) → shipped (final); guard becomes an admit.
    assertEquals(stateMachines.length, 1);
    const sm = stateMachines[0];
    assertEquals(sm.aggregate, 'widget');
    assertEquals(sm.document.initial, 'created');
    assertEquals(sm.document.states, [{ name: 'created' }, { name: 'shipped', final: true }]);
    assertEquals(sm.document.transitions, [
        { on: 'widget-created', to: 'created' },
        { on: 'widget-shipped', to: 'shipped' },
    ]);
    assertEquals(sm.document.admits, [{ command: 'ship-widget', from: ['created'], when: 'quantity >= 1' }]);
});

Deno.test('matches by local name when there is no namespace prefix', () => {
    const plain = `<definitions xmlns:esdm="https://esdm-extensions.io/bpmn">
      <process id="P" name="Plain">
        <extensionElements><esdm:meta context="plain" aggregate="thing"/></extensionElements>
        <task id="t" name="do thing"/>
      </process>
    </definitions>`;
    const parsed = parseBpmn(plain);
    assertEquals(parsed.processes.length, 1);
    assertEquals([...parsed.processes[0].nodes.values()].map((n) => n.subtype), ['task']);
});
