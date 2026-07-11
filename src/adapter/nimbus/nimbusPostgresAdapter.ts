import type { Model } from '../../model/types.ts';
import { camel, snake, studly } from '../../support/str.ts';
import { GeneratedProject } from '../adapter.ts';
import { NimbusEventSourcingDbAdapter } from './nimbusAdapter.ts';
import { q } from './quote.ts';

/**
 * The PostgreSQL flavor of the Nimbus target: same generated application, but
 * the event store is a Postgres `eventstore` table instead of EventSourcingDB.
 * The architecture mirrors the Symfony/patchlevel target: the `id` bigint is
 * the global total order, `(aggregate, aggregate_id, playhead)` is the
 * optimistic-concurrency guard, and a subscription engine with durable cursors
 * in a `subscriptions` table drives projections and policies. The store
 * surface itself is emitted into the app under `src/eventstore/`, mirroring
 * the @nimbus-cqrs/eventsourcingdb function names.
 */
export class NimbusPostgresAdapter extends NimbusEventSourcingDbAdapter {
    override name(): string {
        return 'nimbus-postgres';
    }

    override description(): string {
        return 'Deno + Nimbus (@nimbus-cqrs) + PostgreSQL event store + MongoDB read models (CQRS, event-sourced, Hono HTTP).';
    }

    override slug(): string {
        return 'nimbus-postgres';
    }

    // ---- store seam ---------------------------------------------------------

    protected override createHandlerHeader(): string[] {
        return [
            "import { ulid } from '@std/ulid';",
            'import {',
            '    isSubjectPristine,',
            '    writeEvents,',
            "} from '../../../../../eventstore/store.ts';",
        ];
    }

    protected override mutateHandlerHeader(): string[] {
        return [
            "import { storeEventToNimbusEvent } from '../../../../../eventstore/events.ts';",
            'import {',
            '    isSubjectPopulated,',
            '    readEvents,',
            '    writeEvents,',
            "} from '../../../../../eventstore/store.ts';",
        ];
    }

    protected override storeEventVar(): string {
        return 'storeEvent';
    }

    protected override storeEventType(): string {
        return 'StoreEvent';
    }

    protected override toNimbusEventFn(): string {
        return 'storeEventToNimbusEvent';
    }

    protected override projectionStoreImports(): string[] {
        return [
            'import {',
            '    StoreEvent,',
            '    storeEventToNimbusEvent,',
            "} from '../../../../eventstore/events.ts';",
        ];
    }

    protected override policyStoreImports(): string[] {
        return [
            'import {',
            '    StoreEvent,',
            '    storeEventToNimbusEvent,',
            "} from '../eventstore/events.ts';",
        ];
    }

    /** Cursors live in the `subscriptions` table, not in the read models. */
    protected override repositoryCursorLines(): string[] {
        return [];
    }

    protected override projectionCursorExports(_type: string, _repoVar: string): string[] {
        return [];
    }

    protected override otelFrameworks(): string {
        return 'Hono / MongoDB';
    }

    protected override emitStoreBootstrap(project: GeneratedProject, model: Model): void {
        project.add('src/eventstore/db.ts', this.storeDbTs());
        project.add('src/eventstore/events.ts', this.storeEventsTs());
        project.add('src/eventstore/store.ts', this.storeStoreTs());
        project.add('src/eventstore/engine.ts', this.storeEngineTs());
        project.add('src/eventstore.ts', this.eventStoreTs(model));
    }

    // ---- emitted store module ----------------------------------------------

    /** Connection lifecycle + schema. The two tables ARE the whole store. */
    private storeDbTs(): string {
        return `import { getLogger } from '@nimbus-cqrs/core';
import postgres from 'postgres';

export type Sql = ReturnType<typeof postgres>;

let sql: Sql | null = null;

export const setupEventStore = (url: string): void => {
    sql = postgres(url, { onnotice: () => {} });
};

export const getSql = (): Sql => {
    if (sql === null) {
        throw new Error(
            'Event store is not initialized - call setupEventStore first.',
        );
    }

    return sql;
};

export const pingEventStore = async (): Promise<void> => {
    await getSql()\`SELECT 1\`;
};

/** Bind a payload typed \`unknown\` upstream as a real jsonb object. */
export const jsonb = (value: unknown) => {
    return getSql().json(value as Parameters<Sql['json']>[0]);
};

export const closeEventStore = async (): Promise<void> => {
    if (sql !== null) {
        await sql.end();
        sql = null;
    }
};

export const waitForEventStore = async (): Promise<void> => {
    for (let attempt = 1; attempt <= 60; attempt++) {
        try {
            await pingEventStore();
            return;
        } catch (_error) {
            // not ready yet
        }
        getLogger().info({ message: \`Waiting for PostgreSQL (\${attempt})...\` });
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('PostgreSQL did not become ready in time');
};

// The event log: \`id\` is the global total order, \`playhead\` the per-subject
// version, and the unique index the optimistic-concurrency guard. The
// \`subscriptions\` table holds one durable cursor per projection/policy.
//
// Every event is hash-chained to its predecessor (like EventSourcingDB's
// predecessorhash): a BEFORE INSERT trigger hashes the row over the previous
// event's hash, so any later tampering breaks every hash after it. The chain
// is linear because appends are serialized by the writer's advisory lock.
export const ensureEventStoreSchema = async (): Promise<void> => {
    await getSql().unsafe(\`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE TABLE IF NOT EXISTS eventstore (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            aggregate TEXT NOT NULL,
            aggregate_id TEXT NOT NULL,
            playhead INTEGER NOT NULL,
            event TEXT NOT NULL,
            source TEXT NOT NULL,
            correlation_id TEXT NOT NULL,
            payload JSONB NOT NULL,
            recorded_on TIMESTAMPTZ NOT NULL DEFAULT now(),
            predecessor_hash TEXT NOT NULL,
            hash TEXT NOT NULL,
            UNIQUE (aggregate, aggregate_id, playhead)
        );
        CREATE OR REPLACE FUNCTION eventstore_hash_chain() RETURNS trigger AS $$
        BEGIN
            SELECT hash INTO NEW.predecessor_hash
                FROM eventstore ORDER BY id DESC LIMIT 1;
            NEW.predecessor_hash := COALESCE(NEW.predecessor_hash, repeat('0', 64));
            NEW.recorded_on := COALESCE(NEW.recorded_on, now());
            NEW.hash := encode(digest(jsonb_build_array(
                NEW.predecessor_hash, NEW.aggregate, NEW.aggregate_id,
                NEW.playhead, NEW.event, NEW.source, NEW.correlation_id,
                NEW.payload,
                to_char(NEW.recorded_on AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            )::text, 'sha256'), 'hex');
            RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE OR REPLACE TRIGGER eventstore_hash_chain
            BEFORE INSERT ON eventstore
            FOR EACH ROW EXECUTE FUNCTION eventstore_hash_chain();
        CREATE TABLE IF NOT EXISTS subscriptions (
            id TEXT PRIMARY KEY,
            position BIGINT NOT NULL DEFAULT 0,
            last_saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    \`);
};

/**
 * Recompute every hash against its stored predecessor - a tampered, deleted
 * or reordered event breaks the chain at the first bad row. Returns the id
 * of that row, or null if the whole log is intact.
 */
export const verifyEventChain = async (): Promise<string | null> => {
    const [row] = await getSql()\`
        SELECT min(id) AS broken_at FROM (
            SELECT id,
                hash <> encode(digest(jsonb_build_array(
                    predecessor_hash, aggregate, aggregate_id,
                    playhead, event, source, correlation_id,
                    payload,
                    to_char(recorded_on AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                )::text, 'sha256'), 'hex') AS bad_hash,
                predecessor_hash <> COALESCE(
                    lag(hash) OVER (ORDER BY id), repeat('0', 64)
                ) AS bad_link
            FROM eventstore
        ) checked
        WHERE bad_hash OR bad_link
    \`;

    return row.broken_at === null ? null : String(row.broken_at);
};
`;
    }

    /** The store-level event envelope and its mapping to Nimbus events. */
    private storeEventsTs(): string {
        return `import { Event } from '@nimbus-cqrs/core';

/** One row of the \`eventstore\` table - the store-level event envelope. */
export type StoreEvent = {
    id: string;
    aggregate: string;
    aggregateId: string;
    playhead: number;
    event: string;
    source: string;
    correlationId: string;
    payload: Record<string, unknown>;
    recordedOn: Date;
};

export const rowToStoreEvent = (row: Record<string, unknown>): StoreEvent => {
    return {
        id: String(row.id),
        aggregate: String(row.aggregate),
        aggregateId: String(row.aggregate_id),
        playhead: Number(row.playhead),
        event: String(row.event),
        source: String(row.source),
        correlationId: String(row.correlation_id),
        payload: row.payload as Record<string, unknown>,
        recordedOn: row.recorded_on as Date,
    };
};

export const subjectToStream = (
    subject: string,
): { aggregate: string; aggregateId: string } => {
    const segments = subject.split('/').filter((segment) => segment !== '');

    return {
        aggregate: segments[0] ?? '',
        aggregateId: segments.slice(1).join('/'),
    };
};

export const storeEventToNimbusEvent = <TEvent extends Event>(
    storeEvent: StoreEvent,
): TEvent => {
    return {
        specversion: '1.0',
        id: storeEvent.id,
        correlationid: storeEvent.correlationId,
        time: storeEvent.recordedOn.toISOString(),
        source: storeEvent.source,
        type: storeEvent.event,
        subject: \`/\${storeEvent.aggregate}/\${storeEvent.aggregateId}\`,
        data: storeEvent.payload,
    } as TEvent;
};
`;
    }

    /** Append with preconditions + per-subject replay, same surface as ESDB. */
    private storeStoreTs(): string {
        return `import { Event, Exception } from '@nimbus-cqrs/core';
import { getSql, jsonb } from './db.ts';
import { rowToStoreEvent, StoreEvent, subjectToStream } from './events.ts';

export type Precondition = {
    type: 'isSubjectPristine' | 'isSubjectPopulated';
    subject: string;
};

export const isSubjectPristine = (subject: string): Precondition => {
    return { type: 'isSubjectPristine', subject };
};

export const isSubjectPopulated = (subject: string): Precondition => {
    return { type: 'isSubjectPopulated', subject };
};

// Serializes appends so rows become visible in id order - the subscription
// engine tails \`id > position\` and must never see a gap fill in later.
const APPEND_LOCK = 4711;

export const writeEvents = async (
    events: Event[],
    preconditions: Precondition[] = [],
): Promise<void> => {
    await getSql().begin(async (tx) => {
        await tx\`SELECT pg_advisory_xact_lock(\${APPEND_LOCK})\`;

        for (const precondition of preconditions) {
            const { aggregate, aggregateId } = subjectToStream(
                precondition.subject,
            );
            const [row] = await tx\`
                SELECT COALESCE(MAX(playhead), 0) AS playhead
                FROM eventstore
                WHERE aggregate = \${aggregate}
                    AND aggregate_id = \${aggregateId}
            \`;
            const playhead = Number(row.playhead);

            if (precondition.type === 'isSubjectPristine' && playhead > 0) {
                throw new Exception(
                    'CONFLICT',
                    \`Subject \${precondition.subject} already has events\`,
                    { errorCode: 'SUBJECT_NOT_PRISTINE' },
                    409,
                );
            }
            if (precondition.type === 'isSubjectPopulated' && playhead === 0) {
                throw new Exception(
                    'CONFLICT',
                    \`Subject \${precondition.subject} has no events\`,
                    { errorCode: 'SUBJECT_NOT_POPULATED' },
                    409,
                );
            }
        }

        for (const event of events) {
            const { aggregate, aggregateId } = subjectToStream(event.subject);
            await tx\`
                INSERT INTO eventstore (
                    aggregate, aggregate_id, playhead,
                    event, source, correlation_id, payload
                )
                VALUES (
                    \${aggregate}, \${aggregateId}, (
                        SELECT COALESCE(MAX(playhead), 0) + 1
                        FROM eventstore
                        WHERE aggregate = \${aggregate}
                            AND aggregate_id = \${aggregateId}
                    ),
                    \${event.type}, \${event.source}, \${event.correlationid},
                    \${jsonb(event.data)}
                )
            \`;
        }

        await tx\`SELECT pg_notify('eventstore', '')\`;
    });
};

export async function* readEvents(
    subject: string,
    _options: { recursive: boolean } = { recursive: false },
): AsyncGenerator<StoreEvent, void, void> {
    const sql = getSql();
    const { aggregate, aggregateId } = subjectToStream(subject);

    let position = 0n;
    while (true) {
        const rows = await sql\`
            SELECT *
            FROM eventstore
            WHERE id > \${position.toString()}
                \${aggregate === '' ? sql\`\` : sql\`AND aggregate = \${aggregate}\`}
                \${aggregateId === '' ? sql\`\` : sql\`AND aggregate_id = \${aggregateId}\`}
            ORDER BY id
            LIMIT 200
        \`;
        if (rows.length === 0) {
            return;
        }
        for (const row of rows) {
            yield rowToStoreEvent(row);
        }
        position = BigInt(String(rows[rows.length - 1].id));
    }
}
`;
    }

    /** Cursor-driven subscriptions: catch up, then tail via LISTEN/NOTIFY. */
    private storeEngineTs(): string {
        return `import { getLogger } from '@nimbus-cqrs/core';
import { getSql } from './db.ts';
import { rowToStoreEvent, StoreEvent, subjectToStream } from './events.ts';

export type Subscription = {
    /** Durable cursor id - one row in the \`subscriptions\` table. */
    id: string;
    subject: string;
    eventHandler: (event: StoreEvent) => Promise<void> | void;
};

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 100;

let waiters: (() => void)[] = [];

const wake = (): void => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) {
        resolve();
    }
};

// NOTIFY wakes every subscription; the timeout is the fallback poll.
const waitForWake = (timeoutMs: number): Promise<void> => {
    return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onWake = () => {
            clearTimeout(timer);
            resolve();
        };
        timer = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== onWake);
            resolve();
        }, timeoutMs);
        waiters.push(onWake);
    });
};

export const startSubscriptionEngine = async (
    subscriptions: Subscription[],
): Promise<void> => {
    const sql = getSql();

    for (const subscription of subscriptions) {
        await sql\`
            INSERT INTO subscriptions (id)
            VALUES (\${subscription.id})
            ON CONFLICT (id) DO NOTHING
        \`;
    }

    await sql.listen('eventstore', () => wake());

    for (const subscription of subscriptions) {
        runSubscription(subscription).catch((error) => {
            getLogger().error({
                category: 'SubscriptionEngine',
                message: \`Subscription \${subscription.id} crashed\`,
                error: error as Error,
            });
        });
    }
};

const runSubscription = async (subscription: Subscription): Promise<void> => {
    const sql = getSql();
    const { aggregate } = subjectToStream(subscription.subject);

    const [row] = await sql\`
        SELECT position FROM subscriptions WHERE id = \${subscription.id}
    \`;
    let position = BigInt(String(row.position));

    while (true) {
        const rows = await sql\`
            SELECT *
            FROM eventstore
            WHERE id > \${position.toString()}
                \${aggregate === '' ? sql\`\` : sql\`AND aggregate = \${aggregate}\`}
            ORDER BY id
            LIMIT \${BATCH_SIZE}
        \`;

        if (rows.length === 0) {
            await waitForWake(POLL_INTERVAL_MS);
            continue;
        }

        for (const eventRow of rows) {
            const event = rowToStoreEvent(eventRow);
            if (!(await handleWithRetry(subscription, event))) {
                return; // halted - see the error log
            }
            position = BigInt(event.id);
            await sql\`
                UPDATE subscriptions
                SET position = \${event.id}, last_saved_at = now()
                WHERE id = \${subscription.id}
            \`;
        }
    }
};

const handleWithRetry = async (
    subscription: Subscription,
    event: StoreEvent,
): Promise<boolean> => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            await subscription.eventHandler(event);
            return true;
        } catch (error) {
            if (attempt === MAX_RETRIES) {
                getLogger().error({
                    category: 'SubscriptionEngine',
                    message:
                        \`Subscription \${subscription.id} halted at event \${event.id}\`,
                    error: error as Error,
                });
                return false;
            }
            const delay = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
            getLogger().warn({
                category: 'SubscriptionEngine',
                message:
                    \`Subscription \${subscription.id} retries event \${event.id} in \${delay}ms\`,
            });
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    return false;
};
`;
    }

    /** Wire every projection and policy to its durable subscription. */
    private eventStoreTs(model: Model): string {
        const subscriptions: { id: string; subject: string; handler: string }[] = [];
        const imports = [
            "import { getEnv } from '@nimbus-cqrs/utils';",
            'import {',
            '    ensureEventStoreSchema,',
            '    setupEventStore,',
            '    waitForEventStore,',
            "} from './eventstore/db.ts';",
            "import { startSubscriptionEngine } from './eventstore/engine.ts';",
        ];

        for (const context of model.boundedContexts) {
            for (const readModel of context.readModels) {
                const type = studly(readModel.name);
                const rel = './read/' + context.name + '/' + this.readModelDir(context, readModel) + '/projections/' +
                    camel(readModel.name) + '.projection.ts';
                imports.push('import { project' + type + " } from '" + rel + "';");
                subscriptions.push({
                    id: snake(readModel.name) + '_1',
                    subject: this.projectionSubject(context, readModel),
                    handler: 'project' + type,
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
            subscriptions.push({
                id: snake(policy.name) + '_1',
                subject: this.subjectRoot(handleAgg),
                handler: fn,
            });
        }

        const lines = [...imports];
        lines.push('');
        lines.push('export const initEventStore = async () => {');
        lines.push("    const env = getEnv({ variables: ['POSTGRES_URL'] });");
        lines.push('');
        lines.push('    setupEventStore(env.POSTGRES_URL);');
        lines.push('    await waitForEventStore();');
        lines.push('    await ensureEventStoreSchema();');
        lines.push('');
        lines.push('    // Each id is a durable cursor: the engine replays the log past it,');
        lines.push('    // then tails new events. Delete a row to replay from zero.');
        lines.push('    await startSubscriptionEngine([');
        for (const subscription of subscriptions) {
            lines.push('        {');
            lines.push('            id: ' + q(subscription.id) + ',');
            lines.push('            subject: ' + q(subscription.subject) + ',');
            lines.push('            eventHandler: ' + subscription.handler + ',');
            lines.push('        },');
        }
        lines.push('    ]);');
        lines.push('};');

        return this.file(lines);
    }

    // ---- app bootstrap ------------------------------------------------------

    protected override mainTs(): string {
        return `import './otel.ts';
import {
    getLogger,
    jsonLogFormatter,
    parseLogLevel,
    prettyLogFormatter,
    setupLogger,
} from '@nimbus-cqrs/core';
import { getMongoConnectionManager } from '@nimbus-cqrs/mongodb';
import '@std/dotenv/load';
import process from 'node:process';
import { initEventStore } from './eventstore.ts';
import { closeEventStore } from './eventstore/db.ts';
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

initMongoDB();

// Routers must exist before subscriptions (policies dispatch commands).
initCommandRouter();
initQueryRouter();

await initEventStore();

const server = startHttpServer();

const shutdown = async (signal: string) => {
    getLogger().info({ message: \`Received \${signal}, shutting down...\` });
    await server.shutdown();
    await closeEventStore();
    await getMongoConnectionManager('default').close();
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
`;
    }

    protected override httpTs(): string {
        return `import { getLogger } from '@nimbus-cqrs/core';
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
import { pingEventStore } from './eventstore/db.ts';
import httpQueryRouter from './read/http.ts';
import httpCommandRouter from './write/http.ts';

export const app = new Hono();

app.use(correlationId());
app.use(logger({ enableTracing: true, tracerName: 'api' }));
app.use(cors());
app.use(secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));

app.get('/health', async (c) => {
    const mongoDbHealth = await getMongoConnectionManager().healthCheck();

    let eventStoreHealth = 'OK';
    try {
        await pingEventStore();
    } catch (_error) {
        eventStoreHealth = 'ERROR';
    }

    return c.json({
        timestamp: new Date().toISOString(),
        correlationId: getCorrelationId(c),
        status: {
            httpApi: 'OK',
            mongoDb: mongoDbHealth.status === 'healthy' ? 'OK' : 'ERROR',
            postgres: eventStoreHealth,
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

    protected override devHttpTs(): string {
        return `import { Hono } from 'hono';
import { getSql } from '../eventstore/db.ts';
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
    playhead: number;
    event: string;
    payload: unknown;
    recorded_on: string;
};

httpDevRouter.get('/_dev/events', async (c) => {
    // Newest 50 events, mapped to the uniform 0004 row shape.
    const rows = await getSql()\`
        SELECT id, aggregate, aggregate_id, playhead, event, payload, recorded_on
        FROM eventstore
        ORDER BY id DESC
        LIMIT 50
    \`;

    const result: DevEventRow[] = rows.map((row) => ({
        id: String(row.id),
        aggregate: String(row.aggregate),
        aggregate_id: String(row.aggregate_id),
        playhead: Number(row.playhead),
        event: String(row.event),
        payload: row.payload,
        recorded_on: (row.recorded_on as Date).toISOString(),
    }));

    return c.json(result);
});

export default httpDevRouter;
`;
    }

    protected override denoJson(hasTests: boolean): string {
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
        "hono": "npm:hono@^4.12.23",
        "mongodb": "npm:mongodb@7.1.1",
        "postgres": "npm:postgres@^3.4.9",
        "zod": "npm:zod@^4.3.6"
    }
}
`;
    }

    protected override envExample(): string {
        return `NODE_ENV=development
LOG_LEVEL=debug
LOG_FORMAT=pretty

HTTP_PORT=3100

MONGO_DB=app
MONGO_URL=mongodb://mongo:27017

POSTGRES_URL=postgres://app:app@postgres:5432/app

# OpenTelemetry: set the OTLP endpoint to export traces + metrics (off if unset)
# OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4318
# OTEL_SERVICE_NAME=app
`;
    }

    protected override composeYaml(_appName: string): string {
        return `# Generated stack: postgres (event store), mongo (read models),
# api (Hono HTTP + in-process Nimbus subscriptions).
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "5433:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 3s
      timeout: 3s
      retries: 20

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
      POSTGRES_URL: "postgres://app:app@postgres:5432/app"
    depends_on:
      postgres:
        condition: service_healthy
      mongo:
        condition: service_started
    ports:
      - "8080:3100"

# Domain console: this stack serves the 0004 dev contract (/_dev/*) — point the
# esdm-vue-reader viewer at http://localhost:8080 for commands / read models / events.

volumes:
  mongo-data:
  postgres-data:
`;
    }

    protected override appReadme(appName: string): string {
        return `# ${appName} (generated)

Generated by **esdm-2-nimbus** with the \`nimbus-postgres\` target —
a Deno/TypeScript app built on **Nimbus** (\`@nimbus-cqrs\`) with
**PostgreSQL** as the event store and **MongoDB** for read models.
Do not edit by hand — change the ESDM model and regenerate.

## Architecture

- **Write side**: \`POST /<context>/<command>\` builds a Nimbus command, the
  message router validates it and calls the handler. The handler rebuilds
  aggregate state by replaying the subject's events from the \`eventstore\`
  table, runs the pure core decider, and appends the resulting events in one
  transaction — \`(aggregate, aggregate_id, playhead)\` is unique, so a violated
  precondition is a 409, never a lost update.
- **Read side**: a subscription engine tails the global event order (the
  \`id\` column, kept gap-free for readers by serializing appends) and projects
  events into MongoDB collections (\`rm_*\`). Its durable cursors live in the
  \`subscriptions\` table — one row per projection. \`GET /<context>/<query>\`
  reads the collections. Reads are eventually consistent with writes.
- **Policies** react to events and dispatch commands across aggregates; they
  are subscriptions too, each with its own cursor.
- **Tamper evidence**: every event is hash-chained to its predecessor
  (\`predecessor_hash\`/\`hash\`, computed in-database on insert), so a mutated,
  deleted or reordered event breaks every hash after it. Call
  \`verifyEventChain()\` from \`src/eventstore/db.ts\` to audit the log — it
  returns the id of the first broken event, or \`null\` when intact.

To rebuild a read model from zero, drop its \`rm_*\` collection and delete its
row from the \`subscriptions\` table — on the next start the engine replays the
whole log into it.

The HTTP surface (\`/<context>/<action>\`) is identical to the other targets, so a
client can't tell which backend is behind it.

## Run

\`\`\`sh
docker compose up -d --build
curl -s localhost:8080/health
curl -s -XPOST localhost:8080/<context>/<create-command> -d '{...}'
curl -s localhost:8080/<context>/<list-query>
curl -s 'localhost:8080/<context>/<get-query>?id=<id>'
\`\`\`

The event log itself is plain SQL away:
\`docker compose exec postgres psql -U app -c 'SELECT * FROM eventstore ORDER BY id'\`.

## Domain console

The app serves the **domain-console contract** (esdm-extensions 0004) in dev:
\`GET /_dev/catalog\` (model catalog), \`GET /_dev/bpmn\` (authoring diagram) and
\`GET /_dev/events\` (newest slice of the event stream), plus CORS. Point the
stack-agnostic **esdm-vue-reader** viewer at \`http://localhost:8080\` to send commands,
watch events and see read models update. The \`/_dev/*\` surface is a dev window — do
not expose it in production.

## Local dev (without Docker)

\`\`\`sh
cp .env.example .env   # compose maps postgres to localhost:5433, mongo to 27018
deno task dev
\`\`\`

## Extending the application

Everything here is derived from the ESDM model — never edit generated code by
hand. To change behavior, change the **model** and regenerate:

- New behavior on the write side → add or extend **commands** and **events**
  (plus state-machine transitions and FEEL guards).
- Reactions ("whenever X happened, do Y") → model a **policy**; it is
  generated as a subscription that dispatches the follow-up command.
- Different views of the data → add or extend **read models**.

Integrations that leave the system (brokers, mail, external APIs) subscribe
to the event store downstream instead of hooking into generated code — every
state change is already a row in the \`eventstore\` table, so consumers need
nothing from this app but the log.
`;
    }
}
