import { assert, assertEquals, assertThrows } from '@std/assert';
import type { RawDocument } from '../src/model/documentLoader.ts';
import { createModel } from '../src/model/modelFactory.ts';

const documents: RawDocument[] = [
    { kind: 'domain', name: 'shop' },
    { kind: 'bounded-context', name: 'sales' },
    {
        kind: 'aggregate',
        name: 'order',
        scope: { boundedContext: 'sales' },
        identifiedBy: { field: 'order-id' },
        state: {
            type: 'object',
            properties: {
                'order-id': { type: 'string' },
                total: { type: 'number', default: 0 },
                paid: { type: 'boolean' },
            },
            required: ['order-id'],
        },
    },
    {
        kind: 'command',
        name: 'place-order',
        scope: { boundedContext: 'sales', aggregate: 'order' },
        data: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] },
        publishes: ['order-placed'],
    },
    {
        kind: 'command',
        name: 'pay-order',
        scope: { boundedContext: 'sales', aggregate: 'order' },
        data: {
            type: 'object',
            properties: { 'order-id': { type: 'string' } },
            required: ['order-id'],
        },
        publishes: ['order-paid'],
        metadata: { annotations: { 'esdm-extensions.io/lifecycle': 'mutate' } },
    },
    {
        kind: 'event',
        name: 'order-placed',
        scope: { boundedContext: 'sales', aggregate: 'order' },
        data: {
            type: 'object',
            properties: { 'order-id': { type: 'string' }, total: { type: 'number' } },
            required: ['order-id', 'total'],
        },
    },
    {
        kind: 'event',
        name: 'order-paid',
        scope: { boundedContext: 'sales', aggregate: 'order' },
        data: { type: 'object', properties: { 'order-id': { type: 'string' } }, required: ['order-id'] },
    },
    {
        kind: 'state-machine',
        name: 'order-lifecycle',
        scope: { boundedContext: 'sales', aggregate: 'order' },
        initial: 'placed',
        states: [{ name: 'placed' }, { name: 'paid', final: true }],
        transitions: [{ on: 'order-paid', to: 'paid' }],
        admits: [{ command: 'pay-order', from: ['placed'], when: 'total > 0' }],
    },
    {
        kind: 'read-model',
        name: 'order-list',
        scope: { boundedContext: 'sales' },
        schema: {
            type: 'object',
            properties: { 'order-id': { type: 'string' }, total: { type: 'number' } },
            required: ['order-id'],
        },
        projections: [
            { aggregate: 'order', event: 'order-placed' },
            { aggregate: 'order', event: 'order-paid' },
        ],
    },
    {
        kind: 'query',
        name: 'list-orders',
        scope: { boundedContext: 'sales' },
        readModel: 'order-list',
        parameters: {},
    },
];

Deno.test('wires aggregates, commands, events and the state machine', () => {
    const model = createModel(documents);

    assertEquals(model.domain, 'shop');
    const order = model.aggregate('sales', 'order');
    assert(order !== null);
    assertEquals(order.identityField, 'order-id');
    assertEquals(order.state.field('order-id')?.isIdentity, true);
    assertEquals(order.state.field('total')?.hasDefault, true);

    // place-order matches the create-verb heuristic; the event inherits it.
    assertEquals(order.commands.map((c) => c.lifecycle), ['create', 'mutate']);
    assertEquals(order.event('order-placed')?.lifecycle, 'create');
    assertEquals(order.event('order-paid')?.lifecycle, 'mutate');
    assertEquals(order.event('order-placed')?.type, 'shop.order.order-placed');
    assertEquals(order.createEvent()?.name, 'order-placed');

    assert(order.stateMachine !== null);
    assertEquals(order.stateMachine.initial, 'placed');
    assertEquals(order.stateMachine.transitionTarget('order-paid'), 'paid');
    assertEquals(order.stateMachine.admitFor('pay-order')?.when, 'total > 0');
    assertEquals(order.stateMachine.states[1].final, true);
});

Deno.test('wires read models and queries into the context', () => {
    const model = createModel(documents);
    const sales = model.boundedContexts.find((c) => c.name === 'sales');

    assert(sales !== undefined);
    const readModel = sales.readModel('order-list');
    assert(readModel !== null);
    assertEquals(readModel.projections.length, 2);
    assert(readModel.projectsEvent('order-paid'));
    assertEquals(sales.queries.map((query) => query.name), ['list-orders']);
});

Deno.test('rejects a model without a domain document', () => {
    assertThrows(() => createModel([{ kind: 'bounded-context', name: 'x' }]), Error, 'no `domain` document');
});
