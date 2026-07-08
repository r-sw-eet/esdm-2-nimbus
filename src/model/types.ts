/**
 * The resolved, framework-agnostic ESDM model: a domain with its bounded
 * contexts and the aggregates/events/commands/read-models/queries inside them,
 * with all cross-references already wired. Adapters consume this; they never
 * touch raw YAML.
 */

/**
 * Aggregate-lifecycle role of a command/event. ESDM is descriptive and does not
 * encode this, so it is derived from a `esdm-extensions.io/lifecycle` annotation,
 * falling back to a verb heuristic on the document name.
 */
export type Lifecycle = 'create' | 'mutate' | 'delete';

const CREATE_VERBS = [
    'add',
    'create',
    'register',
    'open',
    'start',
    'new',
    'init',
    'submit',
    'draft',
    'place',
    'raise',
    'issue',
    'request',
];
const DELETE_VERBS = ['delete', 'remove', 'archive', 'close', 'cancel', 'discard', 'withdraw'];

export const lifecycleFromName = (name: string, annotation: string | null): Lifecycle => {
    if (annotation !== null) {
        if (annotation !== 'create' && annotation !== 'mutate' && annotation !== 'delete') {
            throw new Error(`"${annotation}" is not a valid lifecycle`);
        }

        return annotation;
    }

    const verb = name.split(/[-_]/)[0] ?? '';

    if (CREATE_VERBS.includes(verb)) {
        return 'create';
    }
    if (DELETE_VERBS.includes(verb)) {
        return 'delete';
    }

    return 'mutate';
};

/**
 * One property of a JSON-Schema `object` (an aggregate's `state`, a command's
 * `data`, an event's `data` or a read-model column).
 */
export class Field {
    constructor(
        readonly name: string,
        readonly jsonType: string,
        readonly required: boolean,
        readonly default_: unknown,
        readonly hasDefault: boolean,
        readonly isIdentity: boolean = false,
    ) {}

    withIdentity(isIdentity: boolean): Field {
        return new Field(this.name, this.jsonType, this.required, this.default_, this.hasDefault, isIdentity);
    }
}

/**
 * A parsed JSON-Schema `object` ({type, properties, required}). ESDM uses these
 * for aggregate state, command/event data and read-model rows.
 */
export class Schema implements Iterable<Field> {
    constructor(readonly fields: Field[]) {}

    static fromRaw(raw: Record<string, unknown>): Schema {
        const properties = (raw['properties'] ?? {}) as Record<string, unknown>;
        const required = Array.isArray(raw['required']) ? raw['required'] : [];
        const fields: Field[] = [];

        for (const [name, definition] of Object.entries(properties)) {
            const def = (definition !== null && typeof definition === 'object' ? definition : {}) as Record<
                string,
                unknown
            >;
            fields.push(
                new Field(
                    name,
                    String(def['type'] ?? 'mixed'),
                    required.includes(name),
                    def['default'] ?? null,
                    Object.hasOwn(def, 'default'),
                ),
            );
        }

        return new Schema(fields);
    }

    field(name: string): Field | null {
        return this.fields.find((f) => f.name === name) ?? null;
    }

    has(name: string): boolean {
        return this.field(name) !== null;
    }

    [Symbol.iterator](): Iterator<Field> {
        return this.fields[Symbol.iterator]();
    }
}

export class Event {
    constructor(
        readonly name: string,
        readonly domain: string,
        readonly boundedContext: string,
        readonly aggregate: string,
        readonly data: Schema,
        readonly lifecycle: Lifecycle,
        readonly type: string,
    ) {}
}

export class Command {
    constructor(
        readonly name: string,
        readonly domain: string,
        readonly boundedContext: string,
        readonly aggregate: string,
        readonly data: Schema,
        readonly publishes: string[],
        readonly lifecycle: Lifecycle,
    ) {}

    primaryEvent(): string | null {
        return this.publishes[0] ?? null;
    }
}

export class State {
    constructor(
        readonly name: string,
        readonly final: boolean,
    ) {}
}

/** evolve: an event moves the machine to a state. */
export class Transition {
    constructor(
        readonly event: string,
        readonly to: string,
    ) {}
}

/** decide: a command is admissible from these states, optionally under a FEEL guard. */
export class Admit {
    constructor(
        readonly command: string,
        readonly from: string[],
        readonly when: string | null,
    ) {}
}

/**
 * Aggregate lifecycle (proposal 0001): states + transitions (evolve) + admits
 * (decide). `admits[].when` carries an optional FEEL predicate (proposal 0002).
 */
export class StateMachine {
    constructor(
        readonly boundedContext: string,
        readonly aggregate: string,
        readonly initial: string,
        readonly states: State[],
        readonly transitions: Transition[],
        readonly admits: Admit[],
    ) {}

    /** Target state for an event, or null if the event is state-neutral. */
    transitionTarget(event: string): string | null {
        return this.transitions.find((t) => t.event === event)?.to ?? null;
    }

    admitFor(command: string): Admit | null {
        return this.admits.find((a) => a.command === command) ?? null;
    }

    stateNames(): string[] {
        return this.states.map((s) => s.name);
    }
}

export class Aggregate {
    stateMachine: StateMachine | null = null;

    constructor(
        readonly name: string,
        readonly domain: string,
        readonly boundedContext: string,
        readonly identityField: string,
        readonly state: Schema,
        public events: Event[] = [],
        public commands: Command[] = [],
    ) {}

    /** State fields excluding the identity field. */
    nonIdentityState(): Field[] {
        return this.state.fields.filter((f) => f.name !== this.identityField);
    }

    event(name: string): Event | null {
        return this.events.find((e) => e.name === name) ?? null;
    }

    createEvent(): Event | null {
        return this.events.find((e) => e.lifecycle === 'create') ?? this.events[0] ?? null;
    }
}

/** One entry of a read-model's `projections`: which event feeds the read model. */
export class Projection {
    constructor(
        readonly aggregate: string,
        readonly event: string,
        readonly rule: string | null,
    ) {}
}

export class ReadModel {
    constructor(
        readonly name: string,
        readonly domain: string,
        readonly boundedContext: string,
        readonly paradigm: string | null,
        readonly columns: Schema,
        readonly projections: Projection[],
    ) {}

    projectsEvent(event: string): boolean {
        return this.projections.some((p) => p.event === event);
    }
}

export class Query {
    constructor(
        readonly name: string,
        readonly domain: string,
        readonly boundedContext: string,
        readonly readModel: string,
        readonly parameters: Schema,
    ) {}
}

export class BoundedContext {
    constructor(
        readonly name: string,
        readonly domain: string,
        public aggregates: Aggregate[] = [],
        public readModels: ReadModel[] = [],
        public queries: Query[] = [],
    ) {}

    readModel(name: string): ReadModel | null {
        return this.readModels.find((r) => r.name === name) ?? null;
    }
}

/**
 * An ESDM `policy`: a stateless reaction that emits a command when an event
 * occurs — the cross-aggregate, often cross-context glue of an event-driven
 * system. Modeled here as a single handled event → single emitted command
 * (the common case); both ends reference core documents by name.
 */
export class Policy {
    constructor(
        readonly name: string,
        readonly domain: string,
        readonly handleContext: string,
        readonly handleAggregate: string,
        readonly handleEvent: string,
        readonly emitContext: string,
        readonly emitAggregate: string,
        readonly emitCommand: string,
    ) {}
}

/** One reference to an event with concrete data, used in scenario given/then. */
export class EventExample {
    constructor(
        readonly event: string,
        readonly data: Record<string, unknown>,
    ) {}
}

/**
 * A Given-When-Then scenario (ESDM GWT extension, aggregate variant): replay
 * `given` events, apply the `when` command, expect either `then` events or a
 * rejection.
 */
export class Scenario {
    constructor(
        readonly name: string,
        readonly given: EventExample[],
        readonly commandName: string,
        readonly commandData: Record<string, unknown>,
        readonly thenEvents: EventExample[],
        readonly rejectionReason: string | null,
    ) {}

    isRejection(): boolean {
        return this.rejectionReason !== null;
    }
}

/**
 * A GWT `feature` document (aggregate variant): a set of scenarios about one
 * aggregate. Extension documents never enter the core cross-reference graph;
 * they are resolved against it by name at emit time.
 */
export class Feature {
    constructor(
        readonly name: string,
        readonly domain: string,
        readonly boundedContext: string,
        readonly aggregate: string,
        readonly scenarios: Scenario[],
    ) {}
}

export class Model {
    constructor(
        readonly domain: string,
        readonly boundedContexts: BoundedContext[],
        readonly features: Feature[] = [],
        readonly policies: Policy[] = [],
    ) {}

    aggregate(boundedContext: string, name: string): Aggregate | null {
        for (const context of this.boundedContexts) {
            if (context.name !== boundedContext) {
                continue;
            }
            for (const aggregate of context.aggregates) {
                if (aggregate.name === name) {
                    return aggregate;
                }
            }
        }

        return null;
    }

    aggregates(): Aggregate[] {
        return this.boundedContexts.flatMap((context) => context.aggregates);
    }
}
