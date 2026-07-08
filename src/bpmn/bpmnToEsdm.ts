import { parseFeel } from '../feel/feel.ts';
import { lifecycleFromName } from '../model/types.ts';
import type { BpmnField, BpmnMessageFlow, BpmnProcess, ParsedBpmn } from './bpmnParser.ts';

/**
 * Maps a parsed BPMN model (see {@link parseBpmn}) into ESDM documents: core
 * (domain, bounded-context, aggregate, events, commands, read-model, queries),
 * [0001] state machines and [0002] FEEL guards — the three-stream decomposition
 * of proposal 0003.
 *
 * Each pool/process becomes a bounded-context + aggregate; each task a command
 * and its event. Lifecycle states are taken from `esdm:meta state="…"`; a
 * command's admissible source states and final states are derived by walking the
 * sequence-flow graph; gateway/flow `conditionExpression`s become FEEL guards.
 * Things BPMN cannot express (state names, field types) ride on `esdm:` extension
 * hints; everything structural is read from the diagram.
 */

export interface MappedStateMachine {
    aggregate: string;
    document: Record<string, unknown>;
}

export interface MapResult {
    domain: string;
    documents: Record<string, unknown>[];
    stateMachines: MappedStateMachine[];
    notes: string[];
}

interface ObjectSchema {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
}

interface ResolvedTask {
    id: string;
    command: string;
    lifecycle: string;
    isCreate: boolean;
    fields: BpmnField[];
    state: string | null;
    event: string;
    meta: Record<string, string>;
}

interface Edge {
    from: string;
    to: string;
    condition: string | null;
}

interface ResolvedProcess {
    context: string;
    aggregate: string;
    tasks: Map<string, ResolvedTask>;
    incoming: Map<string, Edge[]>;
    outgoing: Map<string, Edge[]>;
    stateFields: Record<string, string>;
    hasStateMachine: boolean;
    initial: string;
}

const API_CORE = 'schema.esdm.io/core/v1';
const API_SM = 'schema.esdm.io/state-machine/v1';

const PAST: Record<string, string> = {
    add: 'added',
    create: 'created',
    register: 'registered',
    open: 'opened',
    start: 'started',
    submit: 'submitted',
    place: 'placed',
    raise: 'raised',
    issue: 'issued',
    request: 'requested',
    draft: 'drafted',
    pay: 'paid',
    price: 'priced',
    send: 'sent',
    accept: 'accepted',
    reject: 'rejected',
    approve: 'approved',
    ship: 'shipped',
    deliver: 'delivered',
    complete: 'completed',
    rename: 'renamed',
    update: 'updated',
    change: 'changed',
    set: 'set',
    cancel: 'cancelled',
    close: 'closed',
    delete: 'deleted',
    remove: 'removed',
    archive: 'archived',
    withdraw: 'withdrawn',
    discard: 'discarded',
    confirm: 'confirmed',
    fulfil: 'fulfilled',
};

export const mapBpmnToEsdm = (parsed: ParsedBpmn, fallbackDomain: string): MapResult => {
    const domain = slug(parsed.domain ?? '') || fallbackDomain;
    const documents: Record<string, unknown>[] = [{
        apiVersion: API_CORE,
        kind: 'domain',
        name: domain,
        description: 'Generated from a BPMN model (proposal 0003).',
    }];
    const stateMachines: MappedStateMachine[] = [];
    const notes: string[] = [];

    for (const element of parsed.unmapped) {
        notes.push(`unmapped BPMN element: ${element}`);
    }

    // Phase 1 — resolve every process to (context, aggregate, tasks) and index
    // each task so cross-pool message flows can be wired into policies.
    const resolved: ResolvedProcess[] = [];
    const nodeIndex = new Map<string, { context: string; aggregate: string; task: ResolvedTask }>();
    for (const process of parsed.processes) {
        const r = resolveProcess(process, notes);
        resolved.push(r);
        for (const [id, task] of r.tasks) {
            nodeIndex.set(id, { context: r.context, aggregate: r.aggregate, task });
        }
    }

    // Phase 2 — emit core docs + state machine per process.
    for (const r of resolved) {
        emitProcess(r, domain, documents, stateMachines, notes);
    }

    // Phase 3 — message flow across pools → policy (event in A → command in B).
    for (const flow of parsed.messageFlows) {
        emitPolicy(flow, nodeIndex, domain, documents, notes);
    }

    return { domain, documents, stateMachines, notes };
};

/**
 * Resolve a process to (context, aggregate, tasks, graph) without emitting — so
 * message-flow endpoints can be looked up across processes first.
 */
const resolveProcess = (process: BpmnProcess, notes: string[]): ResolvedProcess => {
    const context = slug(process.context || process.name) || 'main';
    const aggregate = slug(process.aggregate || singular(context));

    const [incoming, outgoing] = adjacency(process.flows);

    const tasks = new Map<string, ResolvedTask>();
    for (const [id, node] of process.nodes) {
        if (node.kind !== 'task') {
            continue;
        }
        const command = slug(node.name);
        if (command === '') {
            notes.push(`task without a name skipped: ${id}`);
            continue;
        }
        const lifecycle = node.meta['lifecycle'] ?? lifecycleFromName(command, null);
        tasks.set(id, {
            id,
            command,
            lifecycle,
            isCreate: lifecycle === 'create',
            fields: node.fields,
            state: node.meta['state'] ?? null,
            event: slug(node.meta['event'] ?? '') || deriveEvent(command, aggregate),
            meta: node.meta,
        });
    }

    const stateFields: Record<string, string> = { id: 'string' };
    for (const task of tasks.values()) {
        for (const field of task.fields) {
            stateFields[field.name] = field.type;
        }
    }

    let hasStateMachine = false;
    for (const task of tasks.values()) {
        if (task.state !== null) {
            hasStateMachine = true;
            break;
        }
    }

    return {
        context,
        aggregate,
        tasks,
        incoming,
        outgoing,
        stateFields,
        hasStateMachine,
        initial: process.initial ?? '',
    };
};

/** Emit the ESDM core docs + state machine for one resolved process. */
const emitProcess = (
    r: ResolvedProcess,
    domain: string,
    documents: Record<string, unknown>[],
    stateMachines: MappedStateMachine[],
    notes: string[],
): void => {
    const { context, aggregate, tasks, incoming, outgoing, stateFields, hasStateMachine } = r;

    documents.push({ apiVersion: API_CORE, kind: 'bounded-context', name: context, scope: { domain } });
    documents.push({
        apiVersion: API_CORE,
        kind: 'aggregate',
        name: aggregate,
        scope: { domain, boundedContext: context },
        identifiedBy: { source: 'state', field: 'id' },
        state: objectSchema(stateFields, true),
    });

    // Events, then commands.
    for (const task of tasks.values()) {
        const eventFields: Record<string, string> = { id: 'string' };
        for (const field of task.fields) {
            eventFields[field.name] = field.type;
        }
        const data = objectSchema(eventFields, false);
        if (task.state !== null) {
            data.properties.status = { type: 'string', default: task.state };
            data.required.push('status');
        }
        documents.push({
            apiVersion: API_CORE,
            kind: 'event',
            name: task.event,
            scope: { domain, boundedContext: context, aggregate },
            data,
        });
    }

    for (const task of tasks.values()) {
        const commandFields: Record<string, string> = task.isCreate ? {} : { id: 'string' };
        for (const field of task.fields) {
            commandFields[field.name] = field.type;
        }
        // Pin the resolved lifecycle so the generator does not re-guess it from
        // the verb (e.g. "cancel-order" would otherwise read as delete).
        documents.push({
            apiVersion: API_CORE,
            kind: 'command',
            name: task.command,
            scope: { domain, boundedContext: context, aggregate },
            metadata: { annotations: { 'esdm-extensions.io/lifecycle': task.lifecycle } },
            data: objectSchema(commandFields, false),
            publishes: [task.event],
        });
    }

    // Read model + queries.
    const plural_ = plural(aggregate);
    const rmFields: Record<string, string> = { ...stateFields };
    if (hasStateMachine) {
        rmFields.status = 'string';
    }
    const projections = [...tasks.values()].map((task) => ({
        boundedContext: context,
        aggregate,
        event: task.event,
        rule: projectionRule(task),
    }));
    documents.push({
        apiVersion: API_CORE,
        kind: 'read-model',
        name: plural_,
        scope: { domain, boundedContext: context },
        paradigm: 'tabular',
        schema: objectSchema(rmFields, true),
        projections,
    });
    documents.push({
        apiVersion: API_CORE,
        kind: 'query',
        name: `list-${plural_}`,
        scope: { domain, boundedContext: context },
        readModel: plural_,
        result: { type: 'array', items: { type: 'object' } },
    });
    documents.push({
        apiVersion: API_CORE,
        kind: 'query',
        name: `get-${aggregate}`,
        scope: { domain, boundedContext: context },
        readModel: plural_,
        parameters: objectSchema({ id: 'string' }, false),
        result: { type: 'object' },
    });

    if (!hasStateMachine) {
        return;
    }

    // [0001] state machine, derived from the flow graph.
    const states = new Map<string, boolean>();
    for (const task of tasks.values()) {
        if (task.state !== null) {
            if (!states.has(task.state)) {
                states.set(task.state, false);
            }
            if (isFinalState(task, tasks, outgoing) || task.meta['final'] === 'true') {
                states.set(task.state, true);
            }
        }
    }
    const transitions: Record<string, unknown>[] = [];
    for (const task of tasks.values()) {
        if (task.state !== null) {
            transitions.push({ on: task.event, to: task.state });
        }
    }
    const admits: Record<string, unknown>[] = [];
    for (const task of tasks.values()) {
        if (task.isCreate) {
            continue;
        }
        const from = admitFrom(task, tasks, incoming);
        const when = admitWhen(task, incoming, notes);
        if (from.length === 0 && when === null) {
            continue;
        }
        const admit: Record<string, unknown> = { command: task.command, from };
        if (when !== null) {
            admit.when = when;
        }
        admits.push(admit);
    }

    const initial = slug(r.initial) || initialState(tasks);
    stateMachines.push({
        aggregate,
        document: {
            apiVersion: API_SM,
            kind: 'state-machine',
            name: `${aggregate}-lifecycle`,
            scope: { domain, boundedContext: context, aggregate },
            initial,
            states: [...states.entries()].map(([name, final]) => (final ? { name, final: true } : { name })),
            transitions,
            admits,
        },
    });
};

/**
 * A cross-pool BPMN message flow → an ESDM policy: when the source task's event
 * occurs, emit the target task's command on its aggregate.
 */
const emitPolicy = (
    flow: BpmnMessageFlow,
    index: Map<string, { context: string; aggregate: string; task: ResolvedTask }>,
    domain: string,
    documents: Record<string, unknown>[],
    notes: string[],
): void => {
    const source = index.get(flow.source);
    const target = index.get(flow.target);
    if (source === undefined || target === undefined) {
        notes.push(`message flow ${flow.source} → ${flow.target} not mapped (endpoints must be tasks)`);

        return;
    }

    const event = source.task.event;
    const command = target.task.command;
    documents.push({
        apiVersion: API_CORE,
        kind: 'policy',
        name: slug(flow.name) || `${command}-on-${event}`,
        scope: { domain },
        deliveryGuarantee: 'at-most-once',
        handles: [{ boundedContext: source.context, aggregate: source.aggregate, event }],
        emits: [{ boundedContext: target.context, aggregate: target.aggregate, command }],
    });
};

/**
 * Source states a command is admitted from: the resulting states of the task
 * nodes that reach it through the sequence-flow graph (walking back through
 * gateways/events until a state-bearing task is hit).
 */
const admitFrom = (task: ResolvedTask, tasks: Map<string, ResolvedTask>, incoming: Map<string, Edge[]>): string[] => {
    if (task.meta['from'] !== undefined) {
        return splitList(task.meta['from']);
    }

    const states = new Set<string>();
    const seen = new Set<string>();
    const queue = (incoming.get(task.id) ?? []).map((edge) => edge.from);
    while (queue.length > 0) {
        const id = queue.shift() as string;
        if (seen.has(id)) {
            continue;
        }
        seen.add(id);
        const predecessor = tasks.get(id);
        if (predecessor !== undefined && predecessor.state !== null) {
            states.add(predecessor.state); // stop at the first state-bearing predecessor on this branch
            continue;
        }
        for (const edge of incoming.get(id) ?? []) {
            queue.push(edge.from);
        }
    }

    return [...states];
};

const admitWhen = (task: ResolvedTask, incoming: Map<string, Edge[]>, notes: string[]): string | null => {
    if (task.meta['when'] !== undefined && task.meta['when'] !== '') {
        return validateFeel(task.meta['when'], task.command, notes);
    }

    const conditions = new Set<string>();
    for (const edge of incoming.get(task.id) ?? []) {
        if (edge.condition !== null && edge.condition !== '') {
            conditions.add(edge.condition);
        }
    }
    if (conditions.size === 0) {
        return null;
    }
    const keys = [...conditions];
    const expression = keys.length === 1 ? keys[0] : `(${keys.join(') or (')})`;

    return validateFeel(expression, task.command, notes);
};

const validateFeel = (expression: string, command: string, notes: string[]): string => {
    try {
        parseFeel(expression);
    } catch (e) {
        notes.push(`guard on "${command}" is not valid FEEL (${(e as Error).message}): ${expression}`);
    }

    return expression;
};

const isFinalState = (task: ResolvedTask, tasks: Map<string, ResolvedTask>, outgoing: Map<string, Edge[]>): boolean => {
    const seen = new Set<string>();
    const queue = (outgoing.get(task.id) ?? []).map((edge) => edge.to);
    while (queue.length > 0) {
        const id = queue.shift() as string;
        if (seen.has(id)) {
            continue;
        }
        seen.add(id);
        if (tasks.has(id)) {
            return false; // a downstream task exists — not terminal
        }
        for (const edge of outgoing.get(id) ?? []) {
            queue.push(edge.to);
        }
    }

    return true;
};

const initialState = (tasks: Map<string, ResolvedTask>): string => {
    for (const task of tasks.values()) {
        if (task.isCreate && task.state !== null) {
            return task.state;
        }
    }
    for (const task of tasks.values()) {
        if (task.state !== null) {
            return task.state;
        }
    }

    return '';
};

const adjacency = (flows: BpmnProcess['flows']): [Map<string, Edge[]>, Map<string, Edge[]>] => {
    const incoming = new Map<string, Edge[]>();
    const outgoing = new Map<string, Edge[]>();
    for (const flow of flows) {
        push(outgoing, flow.source, { from: flow.source, to: flow.target, condition: flow.condition });
        push(incoming, flow.target, { from: flow.source, to: flow.target, condition: flow.condition });
    }

    return [incoming, outgoing];
};

const push = (map: Map<string, Edge[]>, key: string, edge: Edge): void => {
    const list = map.get(key);
    if (list === undefined) {
        map.set(key, [edge]);
    } else {
        list.push(edge);
    }
};

const projectionRule = (task: ResolvedTask): string => {
    if (task.lifecycle === 'create') {
        return 'Insert a row.';
    }
    if (task.lifecycle === 'delete') {
        return 'Delete the row.';
    }

    return task.state !== null ? `Update the row and set status to ${task.state}.` : 'Update the row.';
};

const deriveEvent = (command: string, aggregate: string): string => {
    const parts = command.split('-');
    const verb = parts.shift() ?? command;
    let object = parts.join('-');
    if (object === '') {
        object = aggregate;
    }

    return `${object}-${pastParticiple(verb)}`;
};

const pastParticiple = (verb: string): string => {
    if (Object.hasOwn(PAST, verb)) {
        return PAST[verb];
    }

    return verb.endsWith('e') ? `${verb}d` : `${verb}ed`;
};

const objectSchema = (fields: Record<string, string>, withDefaults: boolean): ObjectSchema => {
    const properties: Record<string, unknown> = {};
    for (const [name, type] of Object.entries(fields)) {
        const definition: Record<string, unknown> = { type };
        if (withDefaults && name !== 'id') {
            definition.default = defaultFor(type);
        }
        properties[name] = definition;
    }

    return { type: 'object', properties, required: Object.keys(fields) };
};

const defaultFor = (type: string): unknown => {
    if (type === 'number' || type === 'integer') {
        return 0;
    }
    if (type === 'boolean') {
        return false;
    }

    return '';
};

const splitList = (raw: string): string[] =>
    raw.trim().split(/[\s,]+/).map((part) => slug(part)).filter((s) => s !== '');

const slug = (value: string): string =>
    value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');

const singular = (value: string): string => {
    if (value.endsWith('ies') && value.length > 4) {
        return value.slice(0, -3) + 'y';
    }
    if (value.endsWith('ses') && value.length > 4) {
        return value.slice(0, -2);
    }
    if (value.endsWith('s') && !value.endsWith('ss') && value.length > 3) {
        return value.slice(0, -1);
    }

    return value;
};

const plural = (value: string): string => {
    if (value.endsWith('y') && !/[aeiou]y$/.test(value)) {
        return value.slice(0, -1) + 'ies';
    }
    if (/(s|x|z|ch|sh)$/.test(value)) {
        return value + 'es';
    }

    return value + 's';
};
