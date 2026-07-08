import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { NimbusEventSourcingDbAdapter } from '../src/adapter/nimbus/nimbusAdapter.ts';
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
        name: 'delete-task',
        scope: { boundedContext: 'tasks', aggregate: 'task' },
        data: {
            type: 'object',
            properties: { 'task-id': { type: 'string' } },
            required: ['task-id'],
        },
        publishes: ['task-deleted'],
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
        name: 'task-deleted',
        scope: { boundedContext: 'tasks', aggregate: 'task' },
        data: { type: 'object', properties: { 'task-id': { type: 'string' } }, required: ['task-id'] },
    },
    {
        kind: 'state-machine',
        name: 'task-lifecycle',
        scope: { boundedContext: 'tasks', aggregate: 'task' },
        initial: 'open',
        states: [{ name: 'open' }, { name: 'deleted', final: true }],
        transitions: [{ on: 'task-deleted', to: 'deleted' }],
        admits: [{ command: 'delete-task', from: ['open'] }],
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
            { aggregate: 'task', event: 'task-deleted' },
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

const generate = () => new NimbusEventSourcingDbAdapter().generate(createModel(documents), { appName: 'todo' });

Deno.test('emits the full application file tree', () => {
    const files = generate().files();

    for (
        const expected of [
            'src/write/tasks/task/core/domain/task.state.ts',
            'src/write/tasks/task/core/events/taskAdded.event.ts',
            'src/write/tasks/task/core/commands/addTask.command.ts',
            'src/write/tasks/task/shell/commands/addTask.command.ts',
            'src/write/tasks/task/shell/commands/registerTaskCommands.ts',
            'src/write/tasks/task/shell/http.ts',
            'src/read/tasks/task-list/projections/taskList.collection.ts',
            'src/read/tasks/task-list/projections/taskList.repository.ts',
            'src/read/tasks/task-list/projections/taskList.projection.ts',
            'src/read/tasks/task-list/queries/listTasks.query.ts',
            'src/read/tasks/registerTasksQueries.ts',
            'src/read/tasks/http.ts',
            'src/write/commandRouter.ts',
            'src/write/http.ts',
            'src/read/queryRouter.ts',
            'src/read/http.ts',
            'src/main.ts',
            'src/http.ts',
            'src/mongodb.ts',
            'src/eventsourcingdb.ts',
            'deno.json',
            'compose.yaml',
            'Dockerfile',
            'README.md',
        ]
    ) {
        assert(files.has(expected), `missing ${expected}`);
    }
});

Deno.test('state reducer applies events and tracks the machine status', () => {
    const files = generate().files();
    const state = files.get('src/write/tasks/task/core/domain/task.state.ts')!;

    assertStringIncludes(state, 'export type TaskState = {');
    assertStringIncludes(state, '    taskId: string;');
    assertStringIncludes(state, '    status?: string;');
    // create event seeds status with the machine's initial state
    assertStringIncludes(state, "            status: 'open',");
    // delete event transitions to the final state
    assertStringIncludes(state, "            status: 'deleted',");
});

Deno.test('guarded decider rejects illegal transitions with 409', () => {
    const files = generate().files();
    const decider = files.get('src/write/tasks/task/core/commands/deleteTask.command.ts')!;

    assertStringIncludes(decider, "import { commandSchema, createEvent, Exception } from '@nimbus-cqrs/core';");
    assertStringIncludes(decider, "    if (!['open'].includes(state.status ?? '')) {");
    assertStringIncludes(decider, "            { errorCode: 'ILLEGAL_TRANSITION', command: 'delete-task' },");
    assertStringIncludes(decider, '            409,');

    // create commands carry no guards
    const create = files.get('src/write/tasks/task/core/commands/addTask.command.ts')!;
    assertEquals(create.includes('Exception'), false);
});

Deno.test('event source defaults to the esdm-extensions.io namespace', () => {
    const files = generate().files();
    const http = files.get('src/write/tasks/task/shell/http.ts')!;

    assertStringIncludes(http, "        source: 'https://esdm-extensions.io/todo',");
});
