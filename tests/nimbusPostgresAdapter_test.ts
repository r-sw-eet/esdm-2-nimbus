import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { NimbusPostgresAdapter } from '../src/adapter/nimbus/nimbusPostgresAdapter.ts';
import type { RawDocument } from '../src/model/documentLoader.ts';
import { createModel } from '../src/model/modelFactory.ts';

const documents: RawDocument[] = [
    { kind: 'domain', name: 'todo' },
    { kind: 'bounded-context', name: 'tasks' },
    {
        kind: 'aggregate',
        name: 'task',
        scope: { boundedContext: 'tasks' },
        identifiedBy: { field: 'task-id' },
        state: {
            type: 'object',
            properties: { 'task-id': { type: 'string' }, title: { type: 'string' } },
            required: ['task-id', 'title'],
        },
    },
    {
        kind: 'command',
        name: 'add-task',
        scope: { boundedContext: 'tasks', aggregate: 'task' },
        data: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        publishes: ['task-added'],
    },
    {
        kind: 'command',
        name: 'complete-task',
        scope: { boundedContext: 'tasks', aggregate: 'task' },
        data: {
            type: 'object',
            properties: { 'task-id': { type: 'string' } },
            required: ['task-id'],
        },
        publishes: ['task-completed'],
    },
    {
        kind: 'event',
        name: 'task-added',
        scope: { boundedContext: 'tasks', aggregate: 'task' },
        data: {
            type: 'object',
            properties: { 'task-id': { type: 'string' }, title: { type: 'string' } },
            required: ['task-id', 'title'],
        },
    },
    {
        kind: 'event',
        name: 'task-completed',
        scope: { boundedContext: 'tasks', aggregate: 'task' },
        data: { type: 'object', properties: { 'task-id': { type: 'string' } }, required: ['task-id'] },
    },
    {
        kind: 'read-model',
        name: 'task-list',
        scope: { boundedContext: 'tasks' },
        schema: {
            type: 'object',
            properties: { 'task-id': { type: 'string' }, title: { type: 'string' } },
            required: ['task-id'],
        },
        projections: [
            { aggregate: 'task', event: 'task-added' },
            { aggregate: 'task', event: 'task-completed' },
        ],
    },
    {
        kind: 'query',
        name: 'list-tasks',
        scope: { boundedContext: 'tasks' },
        readModel: 'task-list',
        parameters: {},
    },
];

const generate = () => new NimbusPostgresAdapter().generate(createModel(documents), { appName: 'todo' });

Deno.test('emits the Postgres event-store module instead of the ESDB client', () => {
    const files = generate().files();

    for (
        const expected of [
            'src/eventstore/db.ts',
            'src/eventstore/events.ts',
            'src/eventstore/store.ts',
            'src/eventstore/engine.ts',
            'src/eventstore.ts',
        ]
    ) {
        assert(files.has(expected), `missing ${expected}`);
    }
    assertEquals(files.has('src/eventsourcingdb.ts'), false);
});

Deno.test('command handlers append to the emitted store with preconditions', () => {
    const files = generate().files();

    const create = files.get('src/write/tasks/task/shell/commands/addTask.command.ts')!;
    assertStringIncludes(create, "} from '../../../../../eventstore/store.ts';");
    assertStringIncludes(create, 'isSubjectPristine');
    assertEquals(create.includes('eventsourcingdb'), false);

    const mutate = files.get('src/write/tasks/task/shell/commands/completeTask.command.ts')!;
    assertStringIncludes(mutate, "import { storeEventToNimbusEvent } from '../../../../../eventstore/events.ts';");
    assertStringIncludes(mutate, 'isSubjectPopulated');
    assertStringIncludes(mutate, 'storeEventToNimbusEvent(storeEvent),');
});

Deno.test('projections consume store events and use no per-collection cursor', () => {
    const files = generate().files();

    const projection = files.get('src/read/tasks/task-list/projections/taskList.projection.ts')!;
    assertStringIncludes(projection, '    storeEvent: StoreEvent,');
    assertEquals(projection.includes('ProjectionLowerBound'), false);

    const repository = files.get('src/read/tasks/task-list/projections/taskList.repository.ts')!;
    assertEquals(repository.includes('getLastProjectedEventId'), false);
});

Deno.test('subscriptions wire projections with durable cursor ids', () => {
    const files = generate().files();
    const eventStore = files.get('src/eventstore.ts')!;

    assertStringIncludes(eventStore, "id: 'task_list_1',");
    assertStringIncludes(eventStore, "subject: '/task',");
    assertStringIncludes(eventStore, 'eventHandler: projectTaskList,');
});

Deno.test('the event log is hash-chained in-database', () => {
    const files = generate().files();
    const db = files.get('src/eventstore/db.ts')!;

    assertStringIncludes(db, 'predecessor_hash TEXT NOT NULL');
    assertStringIncludes(db, 'hash TEXT NOT NULL');
    assertStringIncludes(db, 'CREATE OR REPLACE TRIGGER eventstore_hash_chain');
    assertStringIncludes(db, 'export const verifyEventChain');
});

Deno.test('infra targets Postgres 16 and the postgres driver', () => {
    const files = generate().files();

    assertStringIncludes(files.get('compose.yaml')!, 'image: postgres:16-alpine');
    assertStringIncludes(files.get('deno.json')!, '"postgres": "npm:postgres@');
    assertEquals(files.get('deno.json')!.includes('eventsourcingdb'), false);
    assertStringIncludes(files.get('.env.example')!, 'POSTGRES_URL=');
});
