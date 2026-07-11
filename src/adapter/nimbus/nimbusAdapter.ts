import { type FeelNode, parseFeel } from '../../feel/feel.ts';
import type {
    Aggregate,
    BoundedContext,
    Command,
    Event,
    Model,
    Query,
    ReadModel,
    Scenario,
    Schema,
} from '../../model/types.ts';
import { camel, snake, studly } from '../../support/str.ts';
import { Adapter, GeneratedProject } from '../adapter.ts';
import { compileFeelToTs } from './feelTs.ts';
import { q } from './quote.ts';
import { bsonType, defaultLiteral, tsType, zodWithDefault } from './types.ts';

/**
 * Emits a runnable, dockerized Deno/TypeScript application that implements the
 * ESDM model with CQRS + event sourcing on top of Nimbus (@nimbus-cqrs) and
 * EventSourcingDB. Write side: HTTP command -> pure core decider -> events
 * appended to EventSourcingDB (subject `/<aggregate>/<id>`). Read side: Nimbus
 * event observers project the same events into MongoDB read collections that the
 * query API reads. A single process serves HTTP and runs the projections.
 *
 * Doubles as the base for other Nimbus targets: everything store-specific goes
 * through the protected "store seam" methods, which a subclass overrides to
 * swap the event store while reusing the whole model emission.
 */
export class NimbusEventSourcingDbAdapter implements Adapter {
    name(): string {
        return 'nimbus-eventsourcingdb';
    }

    description(): string {
        return 'Deno + Nimbus (@nimbus-cqrs) + EventSourcingDB + MongoDB read models (CQRS, event-sourced, Hono HTTP).';
    }

    slug(): string {
        return 'nimbus';
    }

    generate(model: Model, options: Record<string, unknown>): GeneratedProject {
        const appName = String(options['appName'] ?? model.domain);
        const source = String(options['source'] ?? 'https://esdm-extensions.io/' + model.domain);

        const project = new GeneratedProject();

        for (const context of model.boundedContexts) {
            for (const aggregate of context.aggregates) {
                this.emitState(project, aggregate);
                this.emitEvents(project, aggregate);
                this.emitCoreCommands(project, aggregate);
                this.emitShellCommands(project, aggregate);
                this.emitCommandRegistry(project, aggregate);
                this.emitCommandHttp(project, context, aggregate, source);
            }
            for (const readModel of context.readModels) {
                this.emitCollection(project, context, readModel);
                this.emitRepository(project, context, readModel);
                this.emitProjection(project, context, readModel);
            }
            for (const query of context.queries) {
                this.emitQuery(project, context, query);
            }
            this.emitQueryRegistry(project, context);
            this.emitQueryHttp(project, context, source);
        }

        this.emitPolicies(project, model, source);
        this.emitRouters(project, model);
        this.emitDev(project, model, options);
        this.emitTests(project, model);
        this.emitBootstrap(project, model, appName);

        return project;
    }

    // ---- store seam (override these to swap the event store) ---------------

    /** Store + id imports of the create command handler. */
    protected createHandlerHeader(): string[] {
        return [
            "import { writeEvents } from '@nimbus-cqrs/eventsourcingdb';",
            "import { ulid } from '@std/ulid';",
            "import { isSubjectPristine } from 'eventsourcingdb';",
        ];
    }

    /** Store imports of the replay-then-decide command handler. */
    protected mutateHandlerHeader(): string[] {
        return [
            'import {',
            '    eventSourcingDBEventToNimbusEvent,',
            '    readEvents,',
            '    writeEvents,',
            "} from '@nimbus-cqrs/eventsourcingdb';",
            "import { isSubjectPopulated } from 'eventsourcingdb';",
        ];
    }

    /** Parameter name for a raw store event in handlers/projections/policies. */
    protected storeEventVar(): string {
        return 'esdbEvent';
    }

    /** Type of a raw store event as imported by projections/policies. */
    protected storeEventType(): string {
        return 'EventSourcingDBEvent';
    }

    /** Function converting a raw store event into a Nimbus event. */
    protected toNimbusEventFn(): string {
        return 'eventSourcingDBEventToNimbusEvent';
    }

    /** Store imports of a projection file (converter + raw event type). */
    protected projectionStoreImports(): string[] {
        return [
            "import { eventSourcingDBEventToNimbusEvent } from '@nimbus-cqrs/eventsourcingdb';",
            "import { Event as EventSourcingDBEvent } from 'eventsourcingdb';",
        ];
    }

    /** Store imports of a policy file (converter + raw event type). */
    protected policyStoreImports(): string[] {
        return this.projectionStoreImports();
    }

    /** The read-model repository's projection-cursor accessor, if the store needs one. */
    protected repositoryCursorLines(): string[] {
        return [
            '',
            '    public async getLastProjectedEventId(): Promise<string> {',
            '        const rows = await this.find({',
            '            filter: {},',
            '            limit: 1,',
            '            skip: 0,',
            '            sort: { revision: -1 },',
            '        });',
            '',
            "        return rows[0]?.revision ?? '0';",
            '    }',
        ];
    }

    /** The projection file's resume-cursor exports, if the store needs them. */
    protected projectionCursorExports(type: string, repoVar: string): string[] {
        return [
            '',
            'export const get' + type + 'ProjectionLowerBound = async () => {',
            '    const lastEventId = await ' + repoVar + '.getLastProjectedEventId();',
            '',
            '    return {',
            '        id: lastEventId,',
            "        type: lastEventId === '0' ? 'inclusive' : 'exclusive',",
            '    };',
            '};',
        ];
    }

    /** The frameworks whose built-in @opentelemetry/api spans the app carries. */
    protected otelFrameworks(): string {
        return 'Hono / MongoDB / EventSourcingDB';
    }

    /** Emit the store client/bootstrap file(s) wiring observers to handlers. */
    protected emitStoreBootstrap(project: GeneratedProject, model: Model): void {
        project.add('src/eventsourcingdb.ts', this.eventSourcingDbTs(model));
    }

    // ---- write: state reducer ---------------------------------------------

    private emitState(project: GeneratedProject, aggregate: Aggregate): void {
        const type = studly(aggregate.name) + 'State';
        const idProp = camel(aggregate.identityField);
        const sm = aggregate.stateMachine;

        const imports = ["import { Event } from '@nimbus-cqrs/core';"];
        for (const event of aggregate.events) {
            imports.push(
                'import { is' + studly(event.name) + "Event } from '../events/" + camel(event.name) + ".event.ts';",
            );
        }

        const lines = [...imports];
        lines.push('');
        lines.push('export type ' + type + ' = {');
        lines.push('    ' + idProp + ': string;');
        for (const field of aggregate.nonIdentityState()) {
            lines.push('    ' + camel(field.name) + '?: ' + tsType(field) + ';');
        }
        if (sm !== null) {
            lines.push('    status?: string;');
        }
        lines.push('};');
        lines.push('');
        lines.push('export const applyEventTo' + type + ' = (');
        lines.push('    state: ' + type + ',');
        lines.push('    event: Event,');
        lines.push('): ' + type + ' => {');

        for (const event of aggregate.events) {
            const guard = 'is' + studly(event.name) + 'Event';
            const assigns = this.stateAssignments(aggregate, event);
            lines.push('    if (' + guard + '(event)) {');
            lines.push('        return {');
            lines.push('            ...state,');
            for (const assign of assigns) {
                lines.push('            ' + assign);
            }
            lines.push('        };');
            lines.push('    }');
        }

        lines.push('    return state;');
        lines.push('};');

        project.add(
            this.writeBase(aggregate) + '/core/domain/' + camel(aggregate.name) + '.state.ts',
            this.file(lines),
        );
    }

    /** The `key: value,` reducer assignments for an event. */
    private stateAssignments(aggregate: Aggregate, event: Event): string[] {
        const out: string[] = [];
        if (event.lifecycle === 'create') {
            for (const field of aggregate.nonIdentityState()) {
                const fieldCamel = camel(field.name);
                out.push(
                    event.data.has(field.name)
                        ? fieldCamel + ': event.data.' + fieldCamel + ','
                        : fieldCamel + ': ' + defaultLiteral(field) + ',',
                );
            }
        } else if (event.lifecycle !== 'delete') {
            for (const field of event.data) {
                if (field.name === aggregate.identityField || !aggregate.state.has(field.name)) {
                    continue;
                }
                const fieldCamel = camel(field.name);
                out.push(fieldCamel + ': event.data.' + fieldCamel + ',');
            }
        }

        if (aggregate.stateMachine !== null) {
            let target = aggregate.stateMachine.transitionTarget(event.name);
            if (target === null && event.lifecycle === 'create') {
                target = aggregate.stateMachine.initial;
            }
            if (target !== null) {
                out.push('status: ' + q(target) + ',');
            }
        }

        return out;
    }

    // ---- write: events -----------------------------------------------------

    private emitEvents(project: GeneratedProject, aggregate: Aggregate): void {
        for (const event of aggregate.events) {
            const eventClass = studly(event.name);
            const eventConst = snake(event.name).toUpperCase() + '_EVENT_TYPE';

            const lines = [
                "import { eventSchema } from '@nimbus-cqrs/core';",
                "import { z } from 'zod';",
                '',
                'export const ' + eventConst + ' = ' + q(event.type) + ';',
                '',
                'export const ' + camel(event.name) + 'EventDataSchema = z.object({',
            ];
            for (const field of event.data) {
                // Strict unless defaulted: downstream emitters rely on every event field being present.
                lines.push('    ' + camel(field.name) + ': ' + zodWithDefault(field) + ',');
            }
            lines.push('});');
            lines.push('');
            lines.push('export const ' + camel(event.name) + 'EventSchema = eventSchema.extend({');
            lines.push('    type: z.literal(' + eventConst + '),');
            lines.push('    data: ' + camel(event.name) + 'EventDataSchema,');
            lines.push('});');
            lines.push('export type ' + eventClass + 'Event = z.infer<typeof ' + camel(event.name) + 'EventSchema>;');
            lines.push('');
            lines.push('export const is' + eventClass + 'Event = (');
            lines.push('    event: { type: string },');
            lines.push('): event is ' + eventClass + 'Event => {');
            lines.push('    return event.type === ' + eventConst + ';');
            lines.push('};');

            project.add(
                this.writeBase(aggregate) + '/core/events/' + camel(event.name) + '.event.ts',
                this.file(lines),
            );
        }
    }

    // ---- write: core command (pure decider) -------------------------------

    private emitCoreCommands(project: GeneratedProject, aggregate: Aggregate): void {
        const idProp = camel(aggregate.identityField);
        const subjectRoot = this.subjectRoot(aggregate);

        for (const command of aggregate.commands) {
            const event = aggregate.event(String(command.primaryEvent()));
            if (event === null) {
                continue;
            }

            const cmdClass = studly(command.name);
            const cmdConst = snake(command.name).toUpperCase() + '_COMMAND_TYPE';
            const eventClass = studly(event.name);
            const eventConst = snake(event.name).toUpperCase() + '_EVENT_TYPE';
            const fn = camel(command.name);
            const guard = this.guard(aggregate, command);

            const imports = [
                'import { commandSchema, createEvent' + (guard.needsException ? ', Exception' : '') +
                " } from '@nimbus-cqrs/core';",
                "import { z } from 'zod';",
                'import { ' + studly(aggregate.name) + "State } from '../domain/" + camel(aggregate.name) +
                ".state.ts';",
                'import {',
                '    ' + eventConst + ',',
                '    ' + eventClass + 'Event,',
                "} from '../events/" + camel(event.name) + ".event.ts';",
            ];

            const lines = [...imports];
            lines.push('');
            lines.push('export const ' + cmdConst + ' = ' + q(this.cmdType(command)) + ';');
            lines.push('');
            lines.push('export const ' + fn + 'InputSchema = z.object({');
            for (const field of command.data) {
                const z = zodWithDefault(field) + (field.required || field.hasDefault ? '' : '.optional()');
                lines.push('    ' + camel(field.name) + ': ' + z + ',');
            }
            lines.push('});');
            lines.push('');
            lines.push('export const ' + fn + 'CommandSchema = commandSchema.extend({');
            lines.push('    type: z.literal(' + cmdConst + '),');
            lines.push('    data: ' + fn + 'InputSchema,');
            lines.push('});');
            lines.push('export type ' + cmdClass + 'Command = z.infer<typeof ' + fn + 'CommandSchema>;');
            lines.push('');
            lines.push('export const ' + fn + ' = (');
            lines.push('    state: ' + studly(aggregate.name) + 'State,');
            lines.push('    command: ' + cmdClass + 'Command,');
            lines.push('): [' + eventClass + 'Event] => {');
            for (const g of guard.lines) {
                lines.push(g);
            }
            lines.push('    const event = createEvent<' + eventClass + 'Event>({');
            lines.push('        type: ' + eventConst + ',');
            lines.push('        source: command.source,');
            lines.push('        correlationid: command.correlationid,');
            lines.push('        subject: `' + subjectRoot + '/${state.' + idProp + '}`,');
            lines.push('        data: {');
            for (const assign of this.eventData(aggregate, command, event)) {
                lines.push('            ' + assign);
            }
            lines.push('        },');
            lines.push('    });');
            lines.push('');
            lines.push('    return [event];');
            lines.push('};');

            project.add(this.writeBase(aggregate) + '/core/commands/' + fn + '.command.ts', this.file(lines));
        }
    }

    /** The `key: value,` entries for the emitted event's data. */
    private eventData(aggregate: Aggregate, command: Command, event: Event): string[] {
        const out: string[] = [];
        const create = command.lifecycle === 'create';
        for (const field of event.data) {
            const fieldCamel = camel(field.name);
            if (field.name === aggregate.identityField) {
                out.push(fieldCamel + ': state.' + camel(aggregate.identityField) + ',');
            } else if (command.data.has(field.name)) {
                out.push(fieldCamel + ': command.data.' + fieldCamel + ',');
            } else if (!create && aggregate.state.has(field.name)) {
                out.push(fieldCamel + ': state.' + fieldCamel + ' ?? ' + defaultLiteral(field) + ',');
            } else {
                out.push(fieldCamel + ': ' + defaultLiteral(field) + ',');
            }
        }

        return out;
    }

    /**
     * Decider guards from the state machine (0001) and FEEL preconditions (0002),
     * compiled to TypeScript. Create commands carry no guards.
     */
    private guard(aggregate: Aggregate, command: Command): { lines: string[]; needsException: boolean } {
        if (command.lifecycle === 'create' || aggregate.stateMachine === null) {
            return { lines: [], needsException: false };
        }
        const admit = aggregate.stateMachine.admitFor(command.name);
        if (admit === null) {
            return { lines: [], needsException: false };
        }

        const lines: string[] = [];
        if (admit.from.length > 0) {
            const fromList = admit.from.map((s) => q(s)).join(', ');
            lines.push('    if (![' + fromList + "].includes(state.status ?? '')) {");
            lines.push('        throw new Exception(');
            lines.push('            ' + q('CONFLICT') + ',');
            lines.push('            `' + command.name + ' is not allowed while "${state.status}"`,');
            lines.push(
                '            { errorCode: ' + q('ILLEGAL_TRANSITION') + ', command: ' + q(command.name) + ' },',
            );
            lines.push('            409,');
            lines.push('        );');
            lines.push('    }');
            lines.push('');
        }
        if (admit.when !== null && admit.when !== '') {
            const expr = compileFeelToTs(parseFeel(admit.when));
            lines.push('    if (!(' + expr + ')) {');
            lines.push('        throw new Exception(');
            lines.push('            ' + q('CONFLICT') + ',');
            lines.push('            ' + q(command.name + ' requires: ' + admit.when) + ',');
            lines.push('            { errorCode: ' + q('GUARD_VIOLATION') + ', command: ' + q(command.name) + ' },');
            lines.push('            409,');
            lines.push('        );');
            lines.push('    }');
            lines.push('');
        }

        return { lines, needsException: lines.length > 0 };
    }

    // ---- write: shell command (handler) -----------------------------------

    private emitShellCommands(project: GeneratedProject, aggregate: Aggregate): void {
        const idProp = camel(aggregate.identityField);
        const stateType = studly(aggregate.name) + 'State';
        const subjectRoot = this.subjectRoot(aggregate);

        for (const command of aggregate.commands) {
            const event = aggregate.event(String(command.primaryEvent()));
            if (event === null) {
                continue;
            }
            const fn = camel(command.name);
            const cmdClass = studly(command.name);
            const create = command.lifecycle === 'create';

            let lines: string[];
            if (create) {
                lines = [
                    ...this.createHandlerHeader(),
                    'import { ' + fn + ', ' + cmdClass + "Command } from '../../core/commands/" + fn +
                    ".command.ts';",
                    'import { ' + stateType + " } from '../../core/domain/" + camel(aggregate.name) + ".state.ts';",
                    '',
                    'export const ' + fn + 'CommandHandler = async (command: ' + cmdClass + 'Command) => {',
                    // A caller-assigned identity makes the create idempotent (a re-issued id hits
                    // isSubjectPristine); an absent or omitted identity field falls back to minting.
                    '    const state: ' + stateType + ' = { ' + idProp + ': ' +
                    (command.data.has(aggregate.identityField) ? 'command.data.' + idProp + ' ?? ulid()' : 'ulid()') +
                    ' };',
                    '',
                    '    const events = ' + fn + '(state, command);',
                    '',
                    '    await writeEvents(events, [isSubjectPristine(events[0].subject)]);',
                    '',
                    '    return { ' + idProp + ': state.' + idProp + ' };',
                    '};',
                ];
            } else {
                lines = [
                    ...this.mutateHandlerHeader(),
                    'import { ' + fn + ', ' + cmdClass + "Command } from '../../core/commands/" + fn +
                    ".command.ts';",
                    'import {',
                    '    applyEventTo' + stateType + ',',
                    '    ' + stateType + ',',
                    "} from '../../core/domain/" + camel(aggregate.name) + ".state.ts';",
                    '',
                    'export const ' + fn + 'CommandHandler = async (command: ' + cmdClass + 'Command) => {',
                    '    let state: ' + stateType + ' = { ' + idProp + ': command.data.' + idProp + ' };',
                    '',
                    '    for await (',
                    '        const ' + this.storeEventVar() + ' of readEvents(',
                    '            `' + subjectRoot + '/${command.data.' + idProp + '}`,',
                    '            { recursive: false },',
                    '        )',
                    '    ) {',
                    '        state = applyEventTo' + stateType + '(',
                    '            state,',
                    '            ' + this.toNimbusEventFn() + '(' + this.storeEventVar() + '),',
                    '        );',
                    '    }',
                    '',
                    '    const events = ' + fn + '(state, command);',
                    '',
                    '    await writeEvents(events, [isSubjectPopulated(events[0].subject)]);',
                    '',
                    '    return { ' + idProp + ': state.' + idProp + ' };',
                    '};',
                ];
            }

            project.add(this.writeBase(aggregate) + '/shell/commands/' + fn + '.command.ts', this.file(lines));
        }
    }

    private emitCommandRegistry(project: GeneratedProject, aggregate: Aggregate): void {
        const register = 'register' + studly(aggregate.name) + 'Commands';

        const lines = ["import { getRouter } from '@nimbus-cqrs/core';"];
        for (const command of aggregate.commands) {
            const fn = camel(command.name);
            const cmdConst = snake(command.name).toUpperCase() + '_COMMAND_TYPE';
            lines.push('import {');
            lines.push('    ' + cmdConst + ',');
            lines.push('    ' + fn + 'CommandSchema,');
            lines.push("} from '../../core/commands/" + fn + ".command.ts';");
            lines.push('import { ' + fn + "CommandHandler } from './" + fn + ".command.ts';");
        }
        lines.push('');
        lines.push('export const ' + register + ' = () => {');
        lines.push("    const router = getRouter('commandRouter');");
        lines.push('');
        for (const command of aggregate.commands) {
            const fn = camel(command.name);
            const cmdConst = snake(command.name).toUpperCase() + '_COMMAND_TYPE';
            lines.push('    router.register(');
            lines.push('        ' + cmdConst + ',');
            lines.push('        ' + fn + 'CommandHandler,');
            lines.push('        ' + fn + 'CommandSchema,');
            lines.push('    );');
            lines.push('');
        }
        lines.push('};');

        project.add(this.writeBase(aggregate) + '/shell/commands/' + register + '.ts', this.file(lines));
    }

    private emitCommandHttp(
        project: GeneratedProject,
        _context: BoundedContext,
        aggregate: Aggregate,
        source: string,
    ): void {
        const lines = [
            "import { createCommand, getRouter } from '@nimbus-cqrs/core';",
            "import { getCorrelationId } from '@nimbus-cqrs/hono';",
            "import { Hono } from 'hono';",
        ];
        for (const command of aggregate.commands) {
            const fn = camel(command.name);
            const cmdClass = studly(command.name);
            const cmdConst = snake(command.name).toUpperCase() + '_COMMAND_TYPE';
            lines.push('import {');
            lines.push('    ' + cmdConst + ',');
            lines.push('    ' + cmdClass + 'Command,');
            lines.push("} from '../core/commands/" + fn + ".command.ts';");
        }
        lines.push('');
        lines.push('const httpCommandRouter = new Hono();');
        lines.push('');
        for (const command of aggregate.commands) {
            const cmdClass = studly(command.name);
            const cmdConst = snake(command.name).toUpperCase() + '_COMMAND_TYPE';
            lines.push("httpCommandRouter.post('/" + command.name + "', async (c) => {");
            lines.push('    const body = await c.req.json();');
            lines.push('    const correlationId = getCorrelationId(c);');
            lines.push('');
            lines.push('    const command = createCommand<' + cmdClass + 'Command>({');
            lines.push('        type: ' + cmdConst + ',');
            lines.push('        source: ' + q(source) + ',');
            lines.push('        correlationid: correlationId,');
            lines.push('        data: body,');
            lines.push('    });');
            lines.push('');
            lines.push("    const result = await getRouter('commandRouter').route(command);");
            lines.push('');
            lines.push('    return c.json(result);');
            lines.push('});');
            lines.push('');
        }
        lines.push('export default httpCommandRouter;');

        project.add(this.writeBase(aggregate) + '/shell/http.ts', this.file(lines));
    }

    // ---- read: collection / repository / projection -----------------------

    private emitCollection(project: GeneratedProject, context: BoundedContext, readModel: ReadModel): void {
        const type = studly(readModel.name);
        const collConst = snake(readModel.name).toUpperCase() + '_COLLECTION';
        const collectionName = 'rm_' + snake(readModel.name);
        const pk = this.primaryKey(readModel);

        const lines = [
            "import { MongoCollectionDefinition } from '@nimbus-cqrs/mongodb';",
            "import { z } from 'zod';",
            '',
            'export const ' + type + ' = z.object({',
            '    _id: z.string().length(24),',
            '    revision: z.string(),',
        ];
        for (const column of readModel.columns) {
            let z = zodWithDefault(column);
            if (!column.hasDefault && !column.required && column.name !== pk) {
                z += '.nullable()';
            }
            lines.push('    ' + camel(column.name) + ': ' + z + ',');
        }
        lines.push('});');
        lines.push('export type ' + type + ' = z.infer<typeof ' + type + '>;');
        lines.push('');
        lines.push('export const ' + collConst + ': MongoCollectionDefinition = {');
        lines.push('    name: ' + q(collectionName) + ',');
        lines.push('    options: {');
        lines.push('        validator: {');
        lines.push('            $jsonSchema: {');
        lines.push("                bsonType: 'object',");
        lines.push('                required: [' + q('revision') + ', ' + q(camel(pk)) + '],');
        lines.push('                properties: {');
        lines.push('                    revision: { bsonType: ' + q('string') + ' },');
        for (const column of readModel.columns) {
            const bson = bsonType(column);
            const allowed = !column.required && column.name !== pk ? '[' + q(bson) + ', ' + q('null') + ']' : q(bson);
            lines.push('                    ' + camel(column.name) + ': { bsonType: ' + allowed + ' },');
        }
        lines.push('                },');
        lines.push('            },');
        lines.push('        },');
        lines.push('    },');
        lines.push('    indexes: [');
        lines.push('        { key: { ' + camel(pk) + ': 1 }, unique: true },');
        lines.push('        { key: { revision: 1 } },');
        lines.push('    ],');
        lines.push('};');

        project.add(
            this.readBase(context, readModel) + '/projections/' + camel(readModel.name) + '.collection.ts',
            this.file(lines),
        );
    }

    private emitRepository(project: GeneratedProject, context: BoundedContext, readModel: ReadModel): void {
        const type = studly(readModel.name);
        const collConst = snake(readModel.name).toUpperCase() + '_COLLECTION';
        const repoVar = camel(readModel.name) + 'Repository';
        const repoClass = type + 'Repository';
        const file = camel(readModel.name);

        const lines = [
            'import {',
            '    getMongoConnectionManager,',
            '    MongoDBRepository,',
            "} from '@nimbus-cqrs/mongodb';",
            "import { getEnv } from '@nimbus-cqrs/utils';",
            "import { Document, ObjectId } from 'mongodb';",
            'import { ' + type + ', ' + collConst + " } from './" + file + ".collection.ts';",
            '',
            'class ' + repoClass + ' extends MongoDBRepository<' + type + '> {',
            '    constructor() {',
            "        const env = getEnv({ variables: ['MONGO_DB'] });",
            '',
            '        super(',
            '            () => {',
            '                return getMongoConnectionManager().getCollection(',
            '                    env.MONGO_DB,',
            '                    ' + collConst + '.name,',
            '                );',
            '            },',
            '            ' + type + ',',
            '            ' + q(type) + ',',
            '        );',
            '    }',
            '',
            '    override _mapDocumentToEntity(doc: Document): ' + type + ' {',
            '        return ' + type + '.parse({',
            '            _id: doc._id.toString(),',
            '            revision: doc.revision,',
        ];
        for (const column of readModel.columns) {
            const columnCamel = camel(column.name);
            lines.push('            ' + columnCamel + ': doc.' + columnCamel + ',');
        }
        lines.push('        });');
        lines.push('    }');
        lines.push('');
        lines.push('    override _mapEntityToDocument(item: ' + type + '): Document {');
        lines.push('        return {');
        lines.push('            _id: new ObjectId(item._id),');
        lines.push('            revision: item.revision,');
        for (const column of readModel.columns) {
            const columnCamel = camel(column.name);
            lines.push('            ' + columnCamel + ': item.' + columnCamel + ',');
        }
        lines.push('        };');
        lines.push('    }');
        lines.push(...this.repositoryCursorLines());
        lines.push('}');
        lines.push('');
        lines.push('export const ' + repoVar + ' = new ' + repoClass + '();');

        project.add(this.readBase(context, readModel) + '/projections/' + file + '.repository.ts', this.file(lines));
    }

    private emitProjection(project: GeneratedProject, context: BoundedContext, readModel: ReadModel): void {
        const type = studly(readModel.name);
        const repoVar = camel(readModel.name) + 'Repository';
        const file = camel(readModel.name);
        const fn = 'project' + type;
        const pk = this.primaryKey(readModel);
        const events = this.projectedEvents(context, readModel);
        const anchor = this.anchorEvent(events);

        const lines = [
            "import { getLogger } from '@nimbus-cqrs/core';",
            ...this.projectionStoreImports(),
            "import { ObjectId } from 'mongodb';",
        ];
        for (const event of events) {
            lines.push('import {');
            lines.push('    is' + studly(event.name) + 'Event,');
            lines.push('    ' + studly(event.name) + 'Event,');
            lines.push("} from '" + this.eventImportFromRead(context, readModel, event) + "';");
        }
        lines.push('import { ' + type + " } from './" + file + ".collection.ts';");
        lines.push('import { ' + repoVar + " } from './" + file + ".repository.ts';");
        lines.push('');
        lines.push('export const ' + fn + ' = async (');
        lines.push('    ' + this.storeEventVar() + ': ' + this.storeEventType() + ',');
        lines.push(') => {');
        const eventUnion = events.map((e) => studly(e.name) + 'Event').join(' | ');
        lines.push(
            '    const event = ' + this.toNimbusEventFn() + '<' + (eventUnion !== '' ? eventUnion : 'never') +
                '>(',
        );
        lines.push('        ' + this.storeEventVar() + ',');
        lines.push('    );');
        lines.push('');

        for (const event of events) {
            lines.push('    if (is' + studly(event.name) + 'Event(event)) {');
            lines.push(...this.projectionBranch(context, readModel, event, pk, event === anchor, type));
            lines.push('        return;');
            lines.push('    }');
            lines.push('');
        }

        lines.push('    getLogger().warn({');
        lines.push('        category: ' + q(fn) + ',');
        lines.push('        message: `Unhandled event type ${(event as { type: string }).type}`,');
        lines.push('    });');
        lines.push('};');
        lines.push(...this.projectionCursorExports(type, repoVar));

        project.add(this.readBase(context, readModel) + '/projections/' + file + '.projection.ts', this.file(lines));
    }

    /** The body of one `if (isXEvent(event)) { ... }` projection branch. */
    private projectionBranch(
        context: BoundedContext,
        readModel: ReadModel,
        event: Event,
        pk: string,
        isAnchor: boolean,
        type: string,
    ): string[] {
        const repoVar = camel(readModel.name) + 'Repository';
        const aggregate = this.aggregateOf(context, event.aggregate);
        const idField = aggregate?.identityField ?? pk;
        const idCamel = camel(idField);
        const pkCamel = camel(pk);

        if (!isAnchor && event.lifecycle === 'delete') {
            return [
                '        const existing = await ' + repoVar + '.findOne({',
                '            filter: { ' + pkCamel + ': event.data.' + idCamel + ' },',
                '        }).catch(() => null);',
                '        if (existing) {',
                '            await ' + repoVar + '.deleteOne({ item: existing });',
                '        }',
            ];
        }

        if (isAnchor) {
            const out = [
                '        const item: ' + type + ' = {',
                '            _id: new ObjectId().toString(),',
                '            revision: event.id,',
            ];
            for (const column of readModel.columns) {
                const columnCamel = camel(column.name);
                if (column.name === idField || column.name === pk) {
                    out.push('            ' + columnCamel + ': event.data.' + idCamel + ',');
                } else if (event.data.has(column.name)) {
                    out.push('            ' + columnCamel + ': event.data.' + columnCamel + ',');
                } else {
                    const defaulted = column.required || column.hasDefault ? defaultLiteral(column) : 'null';
                    out.push('            ' + columnCamel + ': ' + defaulted + ',');
                }
            }
            out.push('        };');
            out.push('        await ' + repoVar + '.insertOne({ item });');

            return out;
        }

        // mutate: update the columns the event carries (besides identity)
        const sets: string[] = [];
        for (const field of event.data) {
            if (field.name === idField || !readModel.columns.has(field.name)) {
                continue;
            }
            const fieldCamel = camel(field.name);
            sets.push('                    ' + fieldCamel + ': event.data.' + fieldCamel + ',');
        }

        const out = [
            '        await ' + repoVar + '.updateOne({',
            '            filter: { ' + pkCamel + ': event.data.' + idCamel + ' },',
            '            update: {',
            '                $set: {',
            '                    revision: event.id,',
        ];
        for (const set of sets) {
            out.push(set);
        }
        out.push('                },');
        out.push('            },');
        out.push('        });');

        return out;
    }

    // ---- read: queries -----------------------------------------------------

    private emitQuery(project: GeneratedProject, context: BoundedContext, query: Query): void {
        const readModel = context.readModel(query.readModel);
        if (readModel === null) {
            return;
        }
        const repoVar = camel(readModel.name) + 'Repository';
        const fn = camel(query.name);
        const queryClass = studly(query.name);
        const queryConst = snake(query.name).toUpperCase() + '_QUERY_TYPE';
        const byId = query.parameters.fields.length > 0;
        const pkCamel = camel(this.primaryKey(readModel));

        const lines = [
            "import { querySchema } from '@nimbus-cqrs/core';",
            "import { z } from 'zod';",
            'import { ' + repoVar + " } from '../projections/" + camel(readModel.name) + ".repository.ts';",
            '',
            'export const ' + queryConst + ' = ' + q(this.queryType(context, query)) + ';',
            '',
            'export const ' + fn + 'QuerySchema = querySchema.extend({',
            '    type: z.literal(' + queryConst + '),',
        ];
        if (byId) {
            lines.push('    data: z.object({ id: z.string() }),');
        } else {
            lines.push('    data: z.object({}),');
        }
        lines.push('});');
        lines.push('export type ' + queryClass + 'Query = z.infer<typeof ' + fn + 'QuerySchema>;');
        lines.push('');

        if (byId) {
            lines.push('export const ' + fn + 'QueryHandler = async (query: ' + queryClass + 'Query) => {');
            lines.push('    const item = await ' + repoVar + '.findOne({');
            lines.push('        filter: { ' + pkCamel + ': query.data.id },');
            lines.push('    });');
            lines.push('');
            // _id is Mongo bookkeeping, revision is the ES event id — neither belongs on the read-model API.
            lines.push('    const { _id, revision: _revision, ...rest } = item;');
            lines.push('');
            lines.push('    return rest;');
            lines.push('};');
        } else {
            lines.push('export const ' + fn + 'QueryHandler = async (_query: ' + queryClass + 'Query) => {');
            lines.push('    const items = await ' + repoVar + '.find({ filter: {}, limit: 0, skip: 0 });');
            lines.push('');
            lines.push('    return items.map((item) => {');
            lines.push('        const { _id, revision: _revision, ...rest } = item;');
            lines.push('        return rest;');
            lines.push('    });');
            lines.push('};');
        }

        project.add(this.readBaseFor(context, readModel) + '/queries/' + fn + '.query.ts', this.file(lines));
    }

    private emitQueryRegistry(project: GeneratedProject, context: BoundedContext): void {
        const ctx = studly(context.name);
        const register = 'register' + ctx + 'Queries';
        const queries = this.resolvableQueries(context);

        const lines = ["import { getRouter } from '@nimbus-cqrs/core';"];
        for (const [query, readModel] of queries) {
            const fn = camel(query.name);
            const queryConst = snake(query.name).toUpperCase() + '_QUERY_TYPE';
            const rel = this.queryImportFromRegistry(context, readModel, query);
            lines.push('import {');
            lines.push('    ' + queryConst + ',');
            lines.push('    ' + fn + 'QueryHandler,');
            lines.push('    ' + fn + 'QuerySchema,');
            lines.push("} from '" + rel + "';");
        }
        lines.push('');
        lines.push('export const ' + register + ' = () => {');
        lines.push("    const router = getRouter('queryRouter');");
        lines.push('');
        for (const [query] of queries) {
            const fn = camel(query.name);
            const queryConst = snake(query.name).toUpperCase() + '_QUERY_TYPE';
            lines.push('    router.register(');
            lines.push('        ' + queryConst + ',');
            lines.push('        ' + fn + 'QueryHandler,');
            lines.push('        ' + fn + 'QuerySchema,');
            lines.push('    );');
            lines.push('');
        }
        lines.push('};');

        project.add('src/read/' + context.name + '/' + register + '.ts', this.file(lines));
    }

    private emitQueryHttp(project: GeneratedProject, context: BoundedContext, source: string): void {
        const queries = this.resolvableQueries(context);

        const lines = [
            "import { createQuery, getRouter } from '@nimbus-cqrs/core';",
            "import { getCorrelationId } from '@nimbus-cqrs/hono';",
            "import { Hono } from 'hono';",
        ];
        for (const [query, readModel] of queries) {
            const queryClass = studly(query.name);
            const queryConst = snake(query.name).toUpperCase() + '_QUERY_TYPE';
            const rel = this.queryImportFromHttp(context, readModel, query);
            lines.push('import {');
            lines.push('    ' + queryConst + ',');
            lines.push('    ' + queryClass + 'Query,');
            lines.push("} from '" + rel + "';");
        }
        lines.push('');
        lines.push('const httpQueryRouter = new Hono();');
        lines.push('');
        for (const [query] of queries) {
            const queryClass = studly(query.name);
            const queryConst = snake(query.name).toUpperCase() + '_QUERY_TYPE';
            const byId = query.parameters.fields.length > 0;
            const path = '/' + query.name;
            lines.push("httpQueryRouter.get('" + path + "', async (c) => {");
            lines.push('    const correlationId = getCorrelationId(c);');
            lines.push('');
            lines.push('    const query = createQuery<' + queryClass + 'Query>({');
            lines.push('        type: ' + queryConst + ',');
            lines.push('        source: ' + q(source) + ',');
            lines.push('        correlationid: correlationId,');
            if (byId) {
                lines.push("        data: { id: c.req.query('id') ?? '' },");
            } else {
                lines.push('        data: {},');
            }
            lines.push('    });');
            lines.push('');
            lines.push("    const result = await getRouter('queryRouter').route(query);");
            lines.push('');
            lines.push('    return c.json(result);');
            lines.push('});');
            lines.push('');
        }
        lines.push('export default httpQueryRouter;');

        project.add('src/read/' + context.name + '/http.ts', this.file(lines));
    }

    // ---- policies (event -> command) --------------------------------------

    private emitPolicies(project: GeneratedProject, model: Model, source: string): void {
        for (const policy of model.policies) {
            const handleAgg = model.aggregate(policy.handleContext, policy.handleAggregate);
            const emitAgg = model.aggregate(policy.emitContext, policy.emitAggregate);
            if (handleAgg === null || emitAgg === null) {
                continue;
            }
            const event = handleAgg.event(policy.handleEvent);
            const command = this.commandOf(emitAgg, policy.emitCommand);
            if (event === null || command === null) {
                continue;
            }

            const fn = camel(policy.name) + 'Policy';
            const eventClass = studly(event.name);
            const cmdClass = studly(command.name);
            const cmdConst = snake(command.name).toUpperCase() + '_COMMAND_TYPE';
            const cmdFn = camel(command.name);
            const handleIdCamel = camel(handleAgg.identityField);
            const targetIdName = camel(policy.handleAggregate) + 'Id';

            const lines = [
                "import { createCommand, getLogger, getRouter } from '@nimbus-cqrs/core';",
                ...this.policyStoreImports(),
                'import {',
                '    is' + eventClass + 'Event,',
                '    ' + eventClass + 'Event,',
                "} from '" +
                this.relFromPolicies(this.writeBase(handleAgg) + '/core/events/' + camel(event.name) + '.event.ts') +
                "';",
                'import {',
                '    ' + cmdConst + ',',
                '    ' + cmdClass + 'Command,',
                "} from '" +
                this.relFromPolicies(this.writeBase(emitAgg) + '/core/commands/' + cmdFn + '.command.ts') +
                "';",
                '',
                'export const ' + fn + ' = async (' + this.storeEventVar() + ': ' + this.storeEventType() +
                ') => {',
                '    const event = ' + this.toNimbusEventFn() + '<' + eventClass + 'Event>(' +
                this.storeEventVar() + ');',
                '    if (!is' + eventClass + 'Event(event)) {',
                '        return;',
                '    }',
                '',
                '    const command = createCommand<' + cmdClass + 'Command>({',
                '        type: ' + cmdConst + ',',
                '        source: ' + q(source) + ',',
                '        correlationid: event.correlationid,',
                '        data: {',
            ];
            for (const field of command.data) {
                const fieldCamel = camel(field.name);
                if (field.name === targetIdName) {
                    lines.push('            ' + fieldCamel + ': event.data.' + handleIdCamel + ',');
                } else if (event.data.has(field.name)) {
                    lines.push('            ' + fieldCamel + ': event.data.' + fieldCamel + ',');
                } else {
                    lines.push('            ' + fieldCamel + ': ' + defaultLiteral(field) + ',');
                }
            }
            lines.push('        },');
            lines.push('    });');
            lines.push('');
            lines.push('    try {');
            lines.push("        await getRouter('commandRouter').route(command);");
            lines.push('    } catch (error) {');
            lines.push('        getLogger().error({');
            lines.push('            category: ' + q(fn) + ',');
            lines.push('            message: `Policy failed to dispatch ' + command.name + '`,');
            lines.push('            error: error as Error,');
            lines.push('        });');
            lines.push('    }');
            lines.push('};');

            project.add('src/policies/' + camel(policy.name) + '.policy.ts', this.file(lines));
        }
    }

    // ---- routers + bootstrap ----------------------------------------------

    private emitRouters(project: GeneratedProject, model: Model): void {
        // command router
        let lines = ["import { getLogger, setupRouter } from '@nimbus-cqrs/core';"];
        for (const aggregate of model.aggregates()) {
            const register = 'register' + studly(aggregate.name) + 'Commands';
            lines.push(
                'import { ' + register + " } from '" +
                    this.relFromSrc(this.writeBase(aggregate) + '/shell/commands/' + register + '.ts', 'write') +
                    "';",
            );
        }
        lines.push('');
        lines.push('export const initCommandRouter = () => {');
        lines.push("    setupRouter('commandRouter', {");
        lines.push('        logInput: (input) => {');
        lines.push(
            "            getLogger().debug({ category: 'CommandRouter', message: 'Received input', data: { input } });",
        );
        lines.push('        },');
        lines.push('        logOutput: (output) => {');
        lines.push(
            "            getLogger().debug({ category: 'CommandRouter', message: 'Output', data: { output } });",
        );
        lines.push('        },');
        lines.push('    });');
        lines.push('');
        for (const aggregate of model.aggregates()) {
            lines.push('    register' + studly(aggregate.name) + 'Commands();');
        }
        lines.push('};');
        project.add('src/write/commandRouter.ts', this.file(lines));

        // command http aggregator
        lines = ["import { Hono } from 'hono';"];
        const mounts: string[] = [];
        for (const context of model.boundedContexts) {
            for (const aggregate of context.aggregates) {
                const httpVar = 'http' + studly(context.name) + studly(aggregate.name) + 'Commands';
                lines.push(
                    'import ' + httpVar + " from './" + context.name + '/' + aggregate.name + "/shell/http.ts';",
                );
                // Group by context only (not aggregate) so routes read /{context}/{command} — same scheme as the Symfony target.
                mounts.push("httpCommandRouter.route('/" + context.name + "', " + httpVar + ');');
            }
        }
        lines.push('');
        lines.push('const httpCommandRouter = new Hono();');
        lines.push('');
        for (const mount of mounts) {
            lines.push(mount);
        }
        lines.push('');
        lines.push('export default httpCommandRouter;');
        project.add('src/write/http.ts', this.file(lines));

        // query router
        lines = ["import { getLogger, setupRouter } from '@nimbus-cqrs/core';"];
        for (const context of model.boundedContexts) {
            if (this.resolvableQueries(context).length === 0) {
                continue;
            }
            const register = 'register' + studly(context.name) + 'Queries';
            lines.push('import { ' + register + " } from './" + context.name + '/' + register + ".ts';");
        }
        lines.push('');
        lines.push('export const initQueryRouter = () => {');
        lines.push("    setupRouter('queryRouter', {");
        lines.push('        logInput: (input) => {');
        lines.push(
            "            getLogger().debug({ category: 'QueryRouter', message: 'Received input', data: { input } });",
        );
        lines.push('        },');
        lines.push('        logOutput: (output) => {');
        lines.push("            getLogger().debug({ category: 'QueryRouter', message: 'Output', data: { output } });");
        lines.push('        },');
        lines.push('    });');
        lines.push('');
        for (const context of model.boundedContexts) {
            if (this.resolvableQueries(context).length === 0) {
                continue;
            }
            lines.push('    register' + studly(context.name) + 'Queries();');
        }
        lines.push('};');
        project.add('src/read/queryRouter.ts', this.file(lines));

        // query http aggregator
        lines = ["import { Hono } from 'hono';"];
        const queryMounts: string[] = [];
        for (const context of model.boundedContexts) {
            if (this.resolvableQueries(context).length === 0) {
                continue;
            }
            const httpVar = 'http' + studly(context.name) + 'Queries';
            lines.push('import ' + httpVar + " from './" + context.name + "/http.ts';");
            queryMounts.push("httpQueryRouter.route('/" + context.name + "', " + httpVar + ');');
        }
        lines.push('');
        lines.push('const httpQueryRouter = new Hono();');
        lines.push('');
        for (const mount of queryMounts) {
            lines.push(mount);
        }
        lines.push('');
        lines.push('export default httpQueryRouter;');
        project.add('src/read/http.ts', this.file(lines));
    }

    // ---- 0004 domain-console contract (dev-only surface) -------------------

    private emitDev(project: GeneratedProject, model: Model, options: Record<string, unknown>): void {
        project.add('src/dev/catalog.ts', this.catalogTs(model));
        project.add('src/dev/bpmn.ts', this.bpmnTs(String(options['bpmnSource'] ?? '')));
        project.add('src/dev/http.ts', this.devHttpTs());
    }

    /**
     * The app's self-description for an external domain console (0004): commands,
     * queries and read models with the row keys THIS app serves (camelCase).
     */
    private catalogTs(model: Model): string {
        const contexts: unknown[] = [];
        for (const context of model.boundedContexts) {
            const base = '/' + context.name;

            const commands: unknown[] = [];
            for (const aggregate of context.aggregates) {
                const feelHints = this.feelFieldHints(aggregate);
                for (const command of aggregate.commands) {
                    const fields: unknown[] = [];
                    for (const field of command.data) {
                        fields.push({
                            name: camel(field.name),
                            type: field.jsonType,
                            feel: feelHints[field.name] ?? null,
                        });
                    }
                    let guard: unknown = null;
                    const admit = aggregate.stateMachine?.admitFor(command.name) ?? null;
                    if (admit !== null && (admit.from.length > 0 || admit.when !== null)) {
                        guard = { from: admit.from, when: admit.when };
                    }
                    commands.push({
                        name: command.name,
                        lifecycle: command.lifecycle,
                        path: base + '/' + command.name,
                        fields: fields,
                        guard: guard,
                    });
                }
            }

            const queries: unknown[] = [];
            for (const query of context.queries) {
                const params: unknown[] = [];
                for (const field of query.parameters) {
                    params.push({ name: camel(field.name), type: field.jsonType });
                }
                queries.push({
                    name: query.name,
                    path: base + '/' + query.name,
                    kind: query.parameters.fields.length > 0 ? 'get' : 'list',
                    params: params,
                    readModel: query.readModel,
                });
            }

            const readModels: unknown[] = [];
            for (const readModel of context.readModels) {
                const columns: unknown[] = [];
                for (const column of readModel.columns) {
                    // Use the camelCase document key — that is what the query handlers return.
                    columns.push({ name: camel(column.name), type: column.jsonType, identity: column.isIdentity });
                }
                let listPath: string | null = null;
                for (const query of context.queries) {
                    if (query.readModel === readModel.name && query.parameters.fields.length === 0) {
                        listPath = base + '/' + query.name;
                        break;
                    }
                }

                // Attach the aggregate's state machine when this read model carries
                // a `status` column — so a console can show the lifecycle per row.
                let stateMachine: unknown = null;
                let projectedAggregate: Aggregate | null = null;
                for (const projection of readModel.projections) {
                    projectedAggregate = this.aggregateOf(context, projection.aggregate);
                    if (projectedAggregate !== null) {
                        break;
                    }
                }
                if (
                    projectedAggregate !== null && projectedAggregate.stateMachine !== null &&
                    readModel.columns.has('status')
                ) {
                    const machine = projectedAggregate.stateMachine;
                    const admits: unknown[] = [];
                    for (const admit of machine.admits) {
                        const cmd = this.commandOf(projectedAggregate, admit.command);
                        admits.push({
                            command: admit.command,
                            from: admit.from,
                            when: admit.when,
                            to: cmd !== null ? machine.transitionTarget(String(cmd.primaryEvent())) : null,
                        });
                    }
                    stateMachine = {
                        statusColumn: 'status',
                        initial: machine.initial,
                        states: machine.states.map((s) => ({ name: s.name, final: s.final })),
                        admits: admits,
                    };
                }

                readModels.push({
                    name: readModel.name,
                    columns: columns,
                    listPath: listPath,
                    stateMachine: stateMachine,
                });
            }

            contexts.push({
                name: context.name,
                commands: commands,
                queries: queries,
                readModels: readModels,
            });
        }

        const json = JSON.stringify({ domain: model.domain, contexts: contexts }, null, 4);

        return "// The app's model catalog for the 0004 domain-console contract (GET /_dev/catalog).\n" +
            'export const catalog = ' + json + ';\n';
    }

    /**
     * Derive, per aggregate-state field, value hints from the FEEL guards that
     * reference it — so a console can offer FEEL-conform inputs. A field
     * compared to today()/now() is temporal; literals it is compared to or
     * tested against (`= "x"`, `in [...]`) become suggested values.
     */
    private feelFieldHints(
        aggregate: Aggregate,
    ): Record<string, { temporal: string | null; values: string[]; rules: string[] }> {
        if (aggregate.stateMachine === null) {
            return {};
        }

        const acc: Record<string, { temporal?: string; values: string[]; rules: string[] }> = {};
        for (const admit of aggregate.stateMachine.admits) {
            if (admit.when === null) {
                continue;
            }
            let ast: FeelNode;
            try {
                ast = parseFeel(admit.when);
            } catch {
                continue;
            }
            this.collectFeelHints(ast, admit.when, acc);
        }

        const hints: Record<string, { temporal: string | null; values: string[]; rules: string[] }> = {};
        for (const [field, data] of Object.entries(acc)) {
            hints[field] = {
                temporal: data.temporal ?? null,
                values: [...new Set(data.values)],
                rules: [...new Set(data.rules)],
            };
        }

        return hints;
    }

    private collectFeelHints(
        node: FeelNode,
        rule: string,
        acc: Record<string, { temporal?: string; values: string[]; rules: string[] }>,
    ): void {
        switch (node.t) {
            case 'and':
            case 'or':
                this.collectFeelHints(node.l, rule, acc);
                this.collectFeelHints(node.r, rule, acc);
                break;
            case 'not':
                this.collectFeelHints(node.e, rule, acc);
                break;
            case 'bin':
                this.recordFeelOperand(node.l, node.r, rule, acc);
                this.recordFeelOperand(node.r, node.l, rule, acc);
                break;
            case 'in':
                if (node.e.t === 'id') {
                    for (const item of node.list) {
                        this.addFeelLiteral(acc, node.e.name, item, rule);
                    }
                }
                break;
        }
    }

    private recordFeelOperand(
        field: FeelNode,
        other: FeelNode,
        rule: string,
        acc: Record<string, { temporal?: string; values: string[]; rules: string[] }>,
    ): void {
        if (field.t !== 'id') {
            return;
        }
        if (other.t === 'call') {
            const entry = acc[field.name] ?? (acc[field.name] = { values: [], rules: [] });
            entry.temporal = other.fn === 'now' ? 'datetime' : 'date';
            entry.rules.push(rule);

            return;
        }
        this.addFeelLiteral(acc, field.name, other, rule);
    }

    private addFeelLiteral(
        acc: Record<string, { temporal?: string; values: string[]; rules: string[] }>,
        field: string,
        literal: FeelNode,
        rule: string,
    ): void {
        let value: string | null = null;
        if (literal.t === 'str' || literal.t === 'num') {
            value = String(literal.v);
        } else if (literal.t === 'bool') {
            value = literal.v ? 'true' : 'false';
        }
        if (value === null) {
            return;
        }
        const entry = acc[field] ?? (acc[field] = { values: [], rules: [] });
        entry.values.push(value);
        entry.rules.push(rule);
    }

    private bpmnTs(bpmnSource: string): string {
        return '// The authoring BPMN diagram this app was mapped from (GET /_dev/bpmn).\n' +
            'export const bpmnSource = ' + JSON.stringify(bpmnSource) + ';\n';
    }

    protected devHttpTs(): string {
        return `import { isEventData, readEvents } from '@nimbus-cqrs/eventsourcingdb';
import { Hono } from 'hono';
import { bpmnSource } from './bpmn.ts';
import { catalog } from './catalog.ts';

// Dev-only window onto the app for an external domain console (0004): the
// model catalog, the authoring BPMN and the raw event stream. Not part of
// the domain API — never expose it in production.
const httpDevRouter = new Hono();

httpDevRouter.get('/_dev/catalog', (c) => {
    return c.json(catalog);
});

httpDevRouter.get('/_dev/bpmn', (c) => {
    return c.body(bpmnSource, 200, { 'Content-Type': 'application/xml' });
});

type DevEventRow = {
    id: string;
    aggregate: string;
    aggregate_id: string;
    playhead: null;
    event: string;
    payload: unknown;
    recorded_on: string;
};

httpDevRouter.get('/_dev/events', async (c) => {
    // Newest 50 events, mapped to the uniform 0004 row shape. EventSourcingDB
    // has no per-subject playhead, so that field stays null.
    const rows: DevEventRow[] = [];
    for await (const event of readEvents('/', { recursive: true })) {
        const segments = event.subject.split('/');
        rows.push({
            id: event.id,
            aggregate: segments[1] ?? '',
            aggregate_id: segments[segments.length - 1] ?? '',
            playhead: null,
            event: event.type,
            payload: isEventData(event.data) ? event.data.payload : event.data,
            recorded_on: event.time.toISOString(),
        });
        if (rows.length > 50) {
            rows.shift();
        }
    }
    rows.reverse();

    return c.json(rows);
});

export default httpDevRouter;
`;
    }

    // ---- GWT tests (feature/scenario → Deno tests over the pure decider) ----

    private emitTests(project: GeneratedProject, model: Model): void {
        for (const feature of model.features) {
            const aggregate = model.aggregate(feature.boundedContext, feature.aggregate);
            if (aggregate === null) {
                continue;
            }

            const stateType = studly(aggregate.name) + 'State';
            const reducer = 'applyEventTo' + stateType;
            const idProp = camel(aggregate.identityField);
            const core = '../../src/write/' + aggregate.boundedContext + '/' + aggregate.name + '/core';

            const commandFns = new Map<string, Command>();
            const eventNames = new Set<string>();
            const givenEventNames = new Set<string>();
            let usesFold = false;
            let usesThrows = false;

            const bodies: string[] = [];
            for (const scenario of feature.scenarios) {
                const command = this.commandOf(aggregate, scenario.commandName);
                const event = command !== null ? aggregate.event(String(command.primaryEvent())) : null;
                if (command === null || event === null) {
                    continue;
                }
                commandFns.set(camel(command.name), command);
                for (const ex of scenario.given) {
                    eventNames.add(ex.event);
                    givenEventNames.add(ex.event);
                    usesFold = true;
                }
                for (const ex of scenario.thenEvents) {
                    eventNames.add(ex.event);
                }
                if (scenario.isRejection()) {
                    usesThrows = true;
                }
                bodies.push(
                    ...this.scenarioTest(aggregate, scenario, command, event, idProp, reducer, stateType),
                );
            }

            if (bodies.length === 0) {
                continue;
            }

            const assertNames = usesThrows ? 'assertEquals, assertThrows' : 'assertEquals';
            const coreImports = usesFold ? 'createCommand, createEvent' : 'createCommand';

            const lines: string[] = [
                'import { ' + assertNames + " } from '@std/assert';",
                'import { ' + coreImports + " } from '@nimbus-cqrs/core';",
            ];
            if (usesFold) {
                lines.push('import {');
                lines.push('    ' + reducer + ',');
                lines.push('    ' + stateType + ',');
                lines.push("} from '" + core + '/domain/' + camel(aggregate.name) + ".state.ts';");
            } else {
                lines.push(
                    'import { ' + stateType + " } from '" + core + '/domain/' + camel(aggregate.name) + ".state.ts';",
                );
            }
            for (const [fn, command] of [...commandFns].sort((a, b) => a[0].localeCompare(b[0]))) {
                lines.push('import {');
                lines.push('    ' + fn + ',');
                lines.push('    ' + snake(command.name).toUpperCase() + '_COMMAND_TYPE,');
                lines.push('    ' + studly(command.name) + 'Command,');
                lines.push("} from '" + core + '/commands/' + fn + ".command.ts';");
            }
            for (const evName of [...eventNames].sort()) {
                lines.push('import {');
                lines.push('    ' + snake(evName).toUpperCase() + '_EVENT_TYPE,');
                if (givenEventNames.has(evName)) {
                    lines.push('    ' + studly(evName) + 'Event,');
                }
                lines.push("} from '" + core + '/events/' + camel(evName) + ".event.ts';");
            }
            lines.push('');
            lines.push(...bodies);

            project.add(
                'tests/' + feature.boundedContext + '/' + camel(feature.name) + '.test.ts',
                this.file(lines),
            );
        }
    }

    private scenarioTest(
        aggregate: Aggregate,
        scenario: Scenario,
        command: Command,
        event: Event,
        idProp: string,
        reducer: string,
        stateType: string,
    ): string[] {
        const id = this.scenarioId(aggregate, scenario, event);
        const subject = this.subjectRoot(aggregate) + '/' + id;
        const fn = camel(command.name);
        const cmdConst = snake(command.name).toUpperCase() + '_COMMAND_TYPE';
        const cmdType = studly(command.name) + 'Command';

        const lines: string[] = ["Deno.test('" + scenario.name + "', () => {"];
        if (scenario.isRejection() && scenario.rejectionReason !== null) {
            lines.push('    // ' + scenario.rejectionReason);
        }

        // Arrange: seed state with the id, then fold `given` events through the reducer.
        if (scenario.given.length > 0) {
            lines.push('    let state: ' + stateType + ' = { ' + idProp + ': ' + q(id) + ' };');
            for (const ex of scenario.given) {
                const ev = aggregate.event(ex.event);
                if (ev === null) {
                    continue;
                }
                lines.push('    state = ' + reducer + '(');
                lines.push('        state,');
                lines.push('        createEvent<' + studly(ev.name) + 'Event>({');
                lines.push('            type: ' + snake(ev.name).toUpperCase() + '_EVENT_TYPE,');
                lines.push("            source: 'test',");
                lines.push("            correlationid: 'test',");
                lines.push('            subject: ' + q(subject) + ',');
                lines.push('            data: ' + this.dataLiteral(ev.data, ex.data, false) + ',');
                lines.push('        }),');
                lines.push('    );');
            }
        } else {
            lines.push('    const state: ' + stateType + ' = { ' + idProp + ': ' + q(id) + ' };');
        }

        // Act: build the command and run the pure decider.
        lines.push('    const command = createCommand<' + cmdType + '>({');
        lines.push('        type: ' + cmdConst + ',');
        lines.push("        source: 'test',");
        lines.push("        correlationid: 'test',");
        lines.push('        data: ' + this.dataLiteral(command.data, scenario.commandData, true) + ',');
        lines.push('    });');

        // Assert: the emitted events, or a thrown domain rejection (409).
        if (scenario.isRejection()) {
            lines.push('    assertThrows(() => ' + fn + '(state, command));');
        } else {
            lines.push('    const events = ' + fn + '(state, command);');
            lines.push('    assertEquals(events.map((e) => ({ type: e.type, data: e.data })), [');
            for (const ex of scenario.thenEvents) {
                const ev = aggregate.event(ex.event);
                const evConst = ev !== null ? snake(ev.name).toUpperCase() + '_EVENT_TYPE' : "''";
                const data = ev !== null ? this.dataLiteral(ev.data, ex.data, false) : '{}';
                lines.push('        { type: ' + evConst + ', data: ' + data + ' },');
            }
            lines.push('    ]);');
        }

        lines.push('});');
        lines.push('');
        return lines;
    }

    /** The aggregate id a scenario operates on: command data, else the then/given events. */
    private scenarioId(aggregate: Aggregate, scenario: Scenario, event: Event): string {
        const idField = aggregate.identityField;
        const fromCmd = scenario.commandData[idField];
        if (fromCmd !== undefined && fromCmd !== null) {
            return String(fromCmd);
        }
        for (const ex of scenario.thenEvents) {
            if (ex.event === event.name && ex.data[idField] !== undefined && ex.data[idField] !== null) {
                return String(ex.data[idField]);
            }
        }
        for (const ex of scenario.given) {
            if (ex.data[idField] !== undefined && ex.data[idField] !== null) {
                return String(ex.data[idField]);
            }
        }
        return '';
    }

    /** A `{ key: value, … }` object literal over a schema's fields (camelCase keys). */
    private dataLiteral(fields: Schema, data: Record<string, unknown>, onlyPresent: boolean): string {
        const parts: string[] = [];
        for (const field of fields) {
            if (onlyPresent && !(field.name in data)) {
                continue;
            }
            parts.push(camel(field.name) + ': ' + this.tsValue(data[field.name]));
        }
        return parts.length === 0 ? '{}' : '{ ' + parts.join(', ') + ' }';
    }

    private tsValue(value: unknown): string {
        if (typeof value === 'boolean') {
            return value ? 'true' : 'false';
        }
        if (typeof value === 'number') {
            return String(value);
        }
        if (value === null || value === undefined) {
            return 'null';
        }
        return q(String(value));
    }

    private emitBootstrap(project: GeneratedProject, model: Model, appName: string): void {
        project.add('deno.json', this.denoJson(model.features.length > 0));
        project.add('.env.example', this.envExample());
        project.add('.dockerignore', '.git/\n.env\n');
        project.add('Dockerfile', this.dockerfile());
        project.add('compose.yaml', this.composeYaml(appName));
        project.add('README.md', this.appReadme(appName));
        project.add('src/mongodb.ts', this.mongoTs(appName));
        project.add('src/http.ts', this.httpTs());
        project.add('src/otel.ts', this.otelTs(appName));
        project.add('src/main.ts', this.mainTs());
        this.emitStoreBootstrap(project, model);
    }

    private eventSourcingDbTs(model: Model): string {
        const observers: { subject: string; handler: string; lowerBound: string | null }[] = [];
        const imports = [
            "import { setupEventSourcingDBClient } from '@nimbus-cqrs/eventsourcingdb';",
            "import { getEnv } from '@nimbus-cqrs/utils';",
        ];

        for (const context of model.boundedContexts) {
            for (const readModel of context.readModels) {
                const type = studly(readModel.name);
                const rel = './read/' + context.name + '/' + this.readModelDir(context, readModel) + '/projections/' +
                    camel(readModel.name) + '.projection.ts';
                imports.push('import {');
                imports.push('    get' + type + 'ProjectionLowerBound,');
                imports.push('    project' + type + ',');
                imports.push("} from '" + rel + "';");
                observers.push({
                    subject: this.projectionSubject(context, readModel),
                    handler: 'project' + type,
                    lowerBound: 'get' + type + 'ProjectionLowerBound',
                });
            }
        }
        for (const policy of model.policies) {
            const handleAgg = model.aggregate(policy.handleContext, policy.handleAggregate);
            const emitAgg = model.aggregate(policy.emitContext, policy.emitAggregate);
            if (
                handleAgg === null || emitAgg === null ||
                handleAgg.event(policy.handleEvent) === null ||
                this.commandOf(emitAgg, policy.emitCommand) === null
            ) {
                continue;
            }
            const fn = camel(policy.name) + 'Policy';
            imports.push('import { ' + fn + " } from './policies/" + camel(policy.name) + ".policy.ts';");
            observers.push({
                subject: this.subjectRoot(handleAgg),
                handler: fn,
                lowerBound: null,
            });
        }

        const lines = [...imports];
        lines.push('');
        lines.push('export const initEventSourcingDB = async () => {');
        lines.push("    const env = getEnv({ variables: ['ESDB_URL', 'ESDB_API_TOKEN'] });");
        lines.push('');
        lines.push('    await setupEventSourcingDBClient({');
        lines.push('        url: new URL(env.ESDB_URL),');
        lines.push('        apiToken: env.ESDB_API_TOKEN,');
        lines.push('        eventObservers: [');
        for (const observer of observers) {
            lines.push('            {');
            lines.push('                subject: ' + q(observer.subject) + ',');
            lines.push('                recursive: true,');
            lines.push('                eventHandler: ' + observer.handler + ',');
            if (observer.lowerBound !== null) {
                lines.push('                // deno-lint-ignore no-explicit-any');
                lines.push('                lowerBound: await ' + observer.lowerBound + '() as any,');
            }
            lines.push('            },');
        }
        lines.push('        ],');
        lines.push('    });');
        lines.push('};');

        return this.file(lines);
    }

    protected mainTs(): string {
        return `import './otel.ts';
import {
    getLogger,
    jsonLogFormatter,
    parseLogLevel,
    prettyLogFormatter,
    setupLogger,
} from '@nimbus-cqrs/core';
import { getMongoConnectionManager } from '@nimbus-cqrs/mongodb';
import { getEnv } from '@nimbus-cqrs/utils';
import '@std/dotenv/load';
import process from 'node:process';
import { initEventSourcingDB } from './eventsourcingdb.ts';
import { startHttpServer } from './http.ts';
import { initMongoDB } from './mongodb.ts';
import { initQueryRouter } from './read/queryRouter.ts';
import { initCommandRouter } from './write/commandRouter.ts';

setupLogger({
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    formatter: process.env.LOG_FORMAT === 'pretty'
        ? prettyLogFormatter
        : jsonLogFormatter,
    useConsoleColors: process.env.LOG_FORMAT === 'pretty',
});

// Wait for EventSourcingDB to accept connections before wiring observers.
const waitForEventSourcingDB = async () => {
    const env = getEnv({ variables: ['ESDB_URL', 'ESDB_API_TOKEN'] });
    for (let attempt = 1; attempt <= 60; attempt++) {
        try {
            const res = await fetch(new URL('/api/v1/ping', env.ESDB_URL), {
                headers: { authorization: \`Bearer \${env.ESDB_API_TOKEN}\` },
            });
            if (res.ok) {
                return;
            }
        } catch (_error) {
            // not ready yet
        }
        getLogger().info({ message: \`Waiting for EventSourcingDB (\${attempt})...\` });
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('EventSourcingDB did not become ready in time');
};

initMongoDB();

// Routers must exist before observers (policies dispatch commands).
initCommandRouter();
initQueryRouter();

await waitForEventSourcingDB();
await initEventSourcingDB();

const server = startHttpServer();

const shutdown = async (signal: string) => {
    getLogger().info({ message: \`Received \${signal}, shutting down...\` });
    await server.shutdown();
    await getMongoConnectionManager('default').close();
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
`;
    }

    private otelTs(appName: string): string {
        return `import process from 'node:process';
import { context as otelContext, metrics, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

// Registers an SDK for the framework's built-in @opentelemetry/api spans and
// metrics (${this.otelFrameworks()}), which are no-ops without one.
// Imported first by main.ts and registered synchronously so framework
// module-scope meters bind to a live provider. Active only when
// OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://lgtm:4318).
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\\/$/, '');

if (endpoint) {
    try {
        const resource = resourceFromAttributes({
            'service.name': process.env.OTEL_SERVICE_NAME ?? '${appName}',
        });

        const contextManager = new AsyncLocalStorageContextManager();
        contextManager.enable();
        otelContext.setGlobalContextManager(contextManager);
        propagation.setGlobalPropagator(new W3CTraceContextPropagator());

        trace.setGlobalTracerProvider(
            new BasicTracerProvider({
                resource,
                spanProcessors: [
                    new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint + '/v1/traces' })),
                ],
            }),
        );

        metrics.setGlobalMeterProvider(
            new MeterProvider({
                resource,
                readers: [
                    new PeriodicExportingMetricReader({
                        exporter: new OTLPMetricExporter({ url: endpoint + '/v1/metrics' }),
                        exportIntervalMillis: 10000,
                    }),
                ],
            }),
        );

        console.log('OpenTelemetry SDK registered, exporting to ' + endpoint);
    } catch (error) {
        // Telemetry must never take the API down.
        console.error('OpenTelemetry setup failed (continuing without): ' + error);
    }
}
`;
    }

    protected httpTs(): string {
        return `import { getLogger } from '@nimbus-cqrs/core';
import { getEventSourcingDBClient } from '@nimbus-cqrs/eventsourcingdb';
import {
    correlationId,
    getCorrelationId,
    handleError,
    logger,
} from '@nimbus-cqrs/hono';
import { getMongoConnectionManager } from '@nimbus-cqrs/mongodb';
import { getEnv } from '@nimbus-cqrs/utils';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import httpDevRouter from './dev/http.ts';
import httpQueryRouter from './read/http.ts';
import httpCommandRouter from './write/http.ts';

export const app = new Hono();

app.use(correlationId());
app.use(logger({ enableTracing: true, tracerName: 'api' }));
app.use(cors());
app.use(secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));

app.get('/health', async (c) => {
    const mongoDbHealth = await getMongoConnectionManager().healthCheck();

    let eventSourcingDBHealth = 'OK';
    try {
        await getEventSourcingDBClient().ping();
    } catch (_error) {
        eventSourcingDBHealth = 'ERROR';
    }

    return c.json({
        timestamp: new Date().toISOString(),
        correlationId: getCorrelationId(c),
        status: {
            httpApi: 'OK',
            mongoDb: mongoDbHealth.status === 'healthy' ? 'OK' : 'ERROR',
            eventSourcingDB: eventSourcingDBHealth,
        },
    });
});

// Commands (POST) and queries (GET) share one /{context}/{action} space, so a
// client can't tell which backend is behind it.
app.route('/', httpCommandRouter);
app.route('/', httpQueryRouter);

// Dev-only 0004 surface for an external domain console.
app.route('/', httpDevRouter);

app.onError(handleError);

export const startHttpServer = () => {
    const env = getEnv({ variables: ['HTTP_PORT'] });
    const port = Number.parseInt(env.HTTP_PORT);

    return Deno.serve({
        hostname: '0.0.0.0',
        port,
        onListen: ({ port, hostname }) => {
            getLogger().info({
                category: 'HttpApi',
                message: \`Started HTTP API on http://\${hostname}:\${port}\`,
            });
        },
    }, app.fetch);
};
`;
    }

    private mongoTs(appName: string): string {
        const name = this.slugify(appName);

        return `import { setupMongoConnectionManager } from '@nimbus-cqrs/mongodb';
import { getEnv } from '@nimbus-cqrs/utils';
import { ServerApiVersion } from 'mongodb';

export const initMongoDB = () => {
    const env = getEnv({ variables: ['MONGO_URL'] });

    setupMongoConnectionManager({
        name: 'default',
        uri: env['MONGO_URL'],
        options: {
            appName: '${name}',
            serverApi: {
                version: ServerApiVersion.v1,
                strict: false,
                deprecationErrors: true,
            },
        },
    });
};
`;
    }

    protected denoJson(hasTests: boolean): string {
        const testTask = hasTests ? ',\n        "test": "deno test -A"' : '';
        const assertImport = hasTests ? '\n        "@std/assert": "jsr:@std/assert@^1.0.6",' : '';
        return `{
    "tasks": {
        "dev": "deno run -A --watch src/main.ts",
        "start": "deno run -A src/main.ts"${testTask}
    },
    "lint": { "include": ["src/"] },
    "fmt": {
        "include": ["src/"],
        "useTabs": false,
        "lineWidth": 80,
        "indentWidth": 4,
        "semiColons": true,
        "singleQuote": true
    },
    "imports": {
        "@nimbus-cqrs/core": "jsr:@nimbus-cqrs/core@^2.1.2",
        "@nimbus-cqrs/eventsourcingdb": "jsr:@nimbus-cqrs/eventsourcingdb@^2.1.2",
        "@nimbus-cqrs/hono": "jsr:@nimbus-cqrs/hono@^2.1.2",
        "@nimbus-cqrs/mongodb": "jsr:@nimbus-cqrs/mongodb@^2.1.2",
        "@nimbus-cqrs/utils": "jsr:@nimbus-cqrs/utils@^2.1.2",
        "@opentelemetry/api": "npm:@opentelemetry/api@^1.9.1",
        "@opentelemetry/context-async-hooks": "npm:@opentelemetry/context-async-hooks@^2.1.0",
        "@opentelemetry/core": "npm:@opentelemetry/core@^2.1.0",
        "@opentelemetry/exporter-metrics-otlp-http": "npm:@opentelemetry/exporter-metrics-otlp-http@^0.205.0",
        "@opentelemetry/exporter-trace-otlp-http": "npm:@opentelemetry/exporter-trace-otlp-http@^0.205.0",
        "@opentelemetry/resources": "npm:@opentelemetry/resources@^2.1.0",
        "@opentelemetry/sdk-metrics": "npm:@opentelemetry/sdk-metrics@^2.1.0",
        "@opentelemetry/sdk-trace-base": "npm:@opentelemetry/sdk-trace-base@^2.1.0",${assertImport}
        "@std/dotenv": "jsr:@std/dotenv@^0.225.6",
        "@std/ulid": "jsr:@std/ulid@^1.0.0",
        "eventsourcingdb": "npm:eventsourcingdb@^1.8.1",
        "hono": "npm:hono@^4.12.23",
        "mongodb": "npm:mongodb@7.1.1",
        "zod": "npm:zod@^4.3.6"
    }
}
`;
    }

    protected envExample(): string {
        return `NODE_ENV=development
LOG_LEVEL=debug
LOG_FORMAT=pretty

HTTP_PORT=3100

MONGO_DB=app
MONGO_URL=mongodb://mongo:27017

ESDB_URL=http://esdb:3000
ESDB_API_TOKEN=secret

# OpenTelemetry: set the OTLP endpoint to export traces + metrics (off if unset)
# OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4318
# OTEL_SERVICE_NAME=app
`;
    }

    private dockerfile(): string {
        return `FROM denoland/deno:2.9.2

WORKDIR /app
COPY deno.json deno.json
COPY src src

RUN deno cache src/main.ts

EXPOSE 3100
CMD ["run", "-A", "src/main.ts"]
`;
    }

    protected composeYaml(_appName: string): string {
        return `# Generated stack: esdb (EventSourcingDB event store + UI), mongo (read models),
# api (Hono HTTP + in-process Nimbus projections).
services:
  esdb:
    image: thenativeweb/eventsourcingdb:1.2.0
    command:
      - run
      - --api-token=secret
      - --data-directory-temporary
      - --http-enabled
      - --https-enabled=false
      - --with-ui
    ports:
      - "3000:3000"

  mongo:
    image: mongo:7
    ports:
      - "27018:27017"
    volumes:
      - mongo-data:/data/db

  api:
    build: .
    environment:
      NODE_ENV: production
      LOG_LEVEL: info
      LOG_FORMAT: pretty
      HTTP_PORT: "3100"
      MONGO_DB: app
      MONGO_URL: "mongodb://mongo:27017"
      ESDB_URL: "http://esdb:3000"
      ESDB_API_TOKEN: secret
    depends_on:
      - esdb
      - mongo
    ports:
      - "8080:3100"

# Domain console: this stack serves the 0004 dev contract (/_dev/*) — point the
# esdm-vue-reader viewer at http://localhost:8080 for commands / read models / events.

volumes:
  mongo-data:
`;
    }

    protected appReadme(appName: string): string {
        return `# ${appName} (generated)

Generated by **esdm-2-nimbus** with the \`nimbus-eventsourcingdb\` target —
a Deno/TypeScript app built on **Nimbus** (\`@nimbus-cqrs\`) with
**EventSourcingDB** as the event store and **MongoDB** for read models.
Do not edit by hand — change the ESDM model and regenerate.

## Architecture

- **Write side**: \`POST /<context>/<command>\` builds a
  Nimbus command, the message router validates it and calls the handler. The
  handler rebuilds aggregate state by replaying events from EventSourcingDB,
  runs the pure core decider, and appends the resulting events
  (subject \`/<aggregate>/<id>\`) with a concurrency precondition.
- **Read side**: Nimbus event observers project events into MongoDB
  collections (\`rm_*\`). \`GET /<context>/<query>\` reads them. Reads are
  eventually consistent with writes.
- **Policies** react to events and dispatch commands across aggregates.

The HTTP surface (\`/<context>/<action>\`) is identical to the other targets, so a
client can't tell which backend is behind it.

## Run

\`\`\`sh
docker compose up -d --build
# EventSourcingDB UI: http://localhost:3000
curl -s localhost:8080/health
curl -s -XPOST localhost:8080/<context>/<create-command> -d '{...}'
curl -s localhost:8080/<context>/<list-query>
curl -s 'localhost:8080/<context>/<get-query>?id=<id>'
\`\`\`

## Domain console

The app serves the **domain-console contract** (esdm-extensions 0004) in dev:
\`GET /_dev/catalog\` (model catalog), \`GET /_dev/bpmn\` (authoring diagram) and
\`GET /_dev/events\` (newest slice of the event stream), plus CORS. Point the
stack-agnostic **esdm-vue-reader** viewer at \`http://localhost:8080\` to send commands,
watch events and see read models update. The \`/_dev/*\` surface is a dev window — do
not expose it in production.

## Local dev (without Docker)

\`\`\`sh
cp .env.example .env   # point ESDB_URL/MONGO_URL at local services
deno task dev
\`\`\`

## Extending the application

Everything here is derived from the ESDM model — never edit generated code by
hand. To change behavior, change the **model** and regenerate:

- New behavior on the write side → add or extend **commands** and **events**
  (plus state-machine transitions and FEEL guards).
- Reactions ("whenever X happened, do Y") → model a **policy**; it is
  generated as an event observer that dispatches the follow-up command.
- Different views of the data → add or extend **read models**.

Integrations that leave the system (brokers, mail, external APIs) subscribe
to the event store downstream instead of hooking into generated code — every
state change is already an event in EventSourcingDB, so consumers need
nothing from this app but the stream.
`;
    }

    // ---- path helpers ------------------------------------------------------

    private writeBase(aggregate: Aggregate): string {
        return 'src/write/' + aggregate.boundedContext + '/' + aggregate.name;
    }

    private readBase(context: BoundedContext, readModel: ReadModel): string {
        return 'src/read/' + context.name + '/' + readModel.name;
    }

    private readBaseFor(context: BoundedContext, readModel: ReadModel): string {
        return this.readBase(context, readModel);
    }

    protected readModelDir(_context: BoundedContext, readModel: ReadModel): string {
        return readModel.name;
    }

    protected subjectRoot(aggregate: Aggregate): string {
        return '/' + aggregate.name;
    }

    protected projectionSubject(context: BoundedContext, readModel: ReadModel): string {
        const aggregates = new Set<string>();
        for (const event of this.projectedEvents(context, readModel)) {
            aggregates.add(event.aggregate);
        }
        const names = [...aggregates];

        return names.length === 1 ? '/' + names[0] : '/';
    }

    /** Relative import from a read-side projection file to a write-side event module. */
    private eventImportFromRead(_context: BoundedContext, _readModel: ReadModel, event: Event): string {
        // from src/read/<ctx>/<rm>/projections/ -> src/  is four levels up
        return '../../../../write/' + event.boundedContext + '/' + event.aggregate + '/core/events/' +
            camel(event.name) + '.event.ts';
    }

    private queryImportFromRegistry(_context: BoundedContext, readModel: ReadModel, query: Query): string {
        // from src/read/<ctx>/register*.ts -> ./<rm>/queries/<q>.query.ts
        return './' + readModel.name + '/queries/' + camel(query.name) + '.query.ts';
    }

    private queryImportFromHttp(_context: BoundedContext, readModel: ReadModel, query: Query): string {
        return './' + readModel.name + '/queries/' + camel(query.name) + '.query.ts';
    }

    private relFromPolicies(srcPath: string): string {
        // from src/policies/*.ts -> src/...  is one level up
        return './../' + srcPath.slice('src/'.length);
    }

    private relFromSrc(srcPath: string, fromDir: string): string {
        // from src/<fromDir>/*.ts back to a path under src/
        return './' + srcPath.slice(('src/' + fromDir + '/').length);
    }

    // ---- model helpers -----------------------------------------------------

    private cmdType(command: Command): string {
        return command.domain + '.' + command.aggregate + '.' + command.name;
    }

    private queryType(context: BoundedContext, query: Query): string {
        return query.domain + '.' + context.name + '.' + query.name;
    }

    private primaryKey(readModel: ReadModel): string {
        for (const column of readModel.columns) {
            if (column.isIdentity) {
                return column.name;
            }
        }

        return readModel.columns.fields[0]?.name ?? 'id';
    }

    private projectedEvents(context: BoundedContext, readModel: ReadModel): Event[] {
        const events: Event[] = [];
        if (readModel.projections.length > 0) {
            for (const projection of readModel.projections) {
                const aggregate = this.aggregateOf(context, projection.aggregate);
                const event = aggregate?.event(projection.event) ?? null;
                if (event !== null) {
                    events.push(event);
                }
            }

            return events;
        }

        for (const aggregate of context.aggregates) {
            for (const event of aggregate.events) {
                events.push(event);
            }
        }

        return events;
    }

    private anchorEvent(events: Event[]): Event | null {
        return events.find((e) => e.lifecycle === 'create') ?? events[0] ?? null;
    }

    /** Queries whose read model resolves. */
    private resolvableQueries(context: BoundedContext): [Query, ReadModel][] {
        const out: [Query, ReadModel][] = [];
        for (const query of context.queries) {
            const readModel = context.readModel(query.readModel);
            if (readModel !== null) {
                out.push([query, readModel]);
            }
        }

        return out;
    }

    private aggregateOf(context: BoundedContext, name: string): Aggregate | null {
        return context.aggregates.find((a) => a.name === name) ?? null;
    }

    protected commandOf(aggregate: Aggregate, name: string): Command | null {
        return aggregate.commands.find((c) => c.name === name) ?? null;
    }

    protected slugify(value: string): string {
        return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'app';
    }

    protected file(lines: string[]): string {
        return lines.join('\n') + '\n';
    }
}
