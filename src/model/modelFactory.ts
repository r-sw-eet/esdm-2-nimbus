import type { RawDocument } from './documentLoader.ts';
import {
    Admit,
    Aggregate,
    BoundedContext,
    Command,
    Event,
    EventExample,
    Feature,
    Field,
    Lifecycle,
    lifecycleFromName,
    Model,
    Policy,
    Projection,
    Query,
    ReadModel,
    Scenario,
    Schema,
    State,
    StateMachine,
    Transition,
} from './types.ts';

const LIFECYCLE_ANNOTATION = 'esdm-extensions.io/lifecycle';

/**
 * Turns raw ESDM documents into a resolved {@linkcode Model}: groups by kind,
 * builds typed nodes and wires every cross-reference (command -> event, event ->
 * aggregate, read-model -> events, query -> read-model). This is the "parse +
 * map" stage; it knows nothing about any target framework.
 */
export const createModel = (documents: RawDocument[]): Model => {
    const byKind = new Map<string, RawDocument[]>();
    for (const document of documents) {
        const kind = String(document['kind'] ?? '');
        byKind.set(kind, [...(byKind.get(kind) ?? []), document]);
    }

    const domainName = singleDomainName(byKind.get('domain') ?? []);

    const contexts = new Map<string, BoundedContext>();
    for (const document of byKind.get('bounded-context') ?? []) {
        const name = String(document['name']);
        contexts.set(name, new BoundedContext(name, domainName));
    }

    const context = (name: string): BoundedContext => {
        let found = contexts.get(name);
        if (found === undefined) {
            found = new BoundedContext(name, domainName);
            contexts.set(name, found);
        }

        return found;
    };

    // Aggregates, indexed by "context/aggregate" so events/commands can attach.
    const aggregateIndex = new Map<string, Aggregate>();
    for (const document of byKind.get('aggregate') ?? []) {
        const scope = record(document['scope']);
        const contextName = String(scope['boundedContext'] ?? 'default');
        const identityField = String(record(document['identifiedBy'])['field'] ?? 'id');
        const state = schemaWithIdentity(Schema.fromRaw(record(document['state'])), identityField);

        const aggregate = new Aggregate(String(document['name']), domainName, contextName, identityField, state);

        context(contextName).aggregates.push(aggregate);
        aggregateIndex.set(`${contextName}/${aggregate.name}`, aggregate);
    }

    // Commands first: they tell us which events are create/delete.
    const rawCommands = byKind.get('command') ?? [];
    const eventLifecycle = new Map<string, Lifecycle>();
    for (const document of rawCommands) {
        const lifecycle = lifecycleFromName(String(document['name']), annotation(document, LIFECYCLE_ANNOTATION));
        for (const eventName of list(document['publishes'])) {
            eventLifecycle.set(String(eventName), lifecycle);
        }
    }

    // Events.
    for (const document of byKind.get('event') ?? []) {
        const scope = record(document['scope']);
        const contextName = String(scope['boundedContext'] ?? 'default');
        const aggregateName = String(scope['aggregate'] ?? '');
        const aggregate = aggregateIndex.get(`${contextName}/${aggregateName}`);
        if (aggregate === undefined) {
            continue;
        }

        const name = String(document['name']);
        const annotated = annotation(document, LIFECYCLE_ANNOTATION);
        const lifecycle = annotated !== null
            ? lifecycleFromName(name, annotated)
            : eventLifecycle.get(name) ?? 'mutate';

        aggregate.events.push(
            new Event(
                name,
                domainName,
                contextName,
                aggregateName,
                schemaWithIdentity(Schema.fromRaw(record(document['data'])), aggregate.identityField),
                lifecycle,
                annotation(document, 'cloudevents.type') ?? `${domainName}.${aggregateName}.${name}`,
            ),
        );
    }

    // Commands -> aggregates (now that events exist).
    for (const document of rawCommands) {
        const scope = record(document['scope']);
        const contextName = String(scope['boundedContext'] ?? 'default');
        const aggregateName = String(scope['aggregate'] ?? '');
        const aggregate = aggregateIndex.get(`${contextName}/${aggregateName}`);
        if (aggregate === undefined) {
            continue;
        }

        const publishes = list(document['publishes']).map((e) => String(e));
        aggregate.commands.push(
            new Command(
                String(document['name']),
                domainName,
                contextName,
                aggregateName,
                Schema.fromRaw(record(document['data'])),
                publishes,
                lifecycleFromName(String(document['name']), annotation(document, LIFECYCLE_ANNOTATION)),
            ),
        );
    }

    // State machines (extension): attach an aggregate lifecycle.
    for (const document of byKind.get('state-machine') ?? []) {
        const scope = record(document['scope']);
        const contextName = String(scope['boundedContext'] ?? 'default');
        const aggregateName = String(scope['aggregate'] ?? '');
        const aggregate = aggregateIndex.get(`${contextName}/${aggregateName}`);
        if (aggregate === undefined) {
            continue;
        }

        const states = list(document['states']).map((state) => {
            const raw = record(state);

            return new State(String(raw['name'] ?? ''), Boolean(raw['final'] ?? false));
        });
        const transitions = list(document['transitions']).map((transition) => {
            const raw = record(transition);

            return new Transition(String(raw['on'] ?? ''), String(raw['to'] ?? ''));
        });
        const admits = list(document['admits']).map((admit) => {
            const raw = record(admit);

            return new Admit(
                String(raw['command'] ?? ''),
                list(raw['from']).map((s) => String(s)),
                raw['when'] != null ? String(raw['when']) : null,
            );
        });

        aggregate.stateMachine = new StateMachine(
            contextName,
            aggregateName,
            String(document['initial'] ?? ''),
            states,
            transitions,
            admits,
        );
    }

    // Read models.
    for (const document of byKind.get('read-model') ?? []) {
        const scope = record(document['scope']);
        const contextName = String(scope['boundedContext'] ?? 'default');
        const projections = list(document['projections']).map((projection) => {
            const raw = record(projection);

            return new Projection(
                String(raw['aggregate'] ?? ''),
                String(raw['event'] ?? ''),
                raw['rule'] != null ? String(raw['rule']) : null,
            );
        });

        context(contextName).readModels.push(
            new ReadModel(
                String(document['name']),
                domainName,
                contextName,
                document['paradigm'] != null ? String(document['paradigm']) : null,
                Schema.fromRaw(record(document['schema'])),
                projections,
            ),
        );
    }

    // Queries.
    for (const document of byKind.get('query') ?? []) {
        const scope = record(document['scope']);
        const contextName = String(scope['boundedContext'] ?? 'default');
        context(contextName).queries.push(
            new Query(
                String(document['name']),
                domainName,
                contextName,
                String(document['readModel'] ?? ''),
                Schema.fromRaw(record(document['parameters'])),
            ),
        );
    }

    return new Model(
        domainName,
        [...contexts.values()],
        parseFeatures(byKind.get('feature') ?? [], domainName),
        parsePolicies(byKind.get('policy') ?? [], domainName),
    );
};

const parsePolicies = (policyDocs: RawDocument[], domainName: string): Policy[] => {
    const policies: Policy[] = [];
    for (const document of policyDocs) {
        const handle = list(document['handles'])[0];
        const emit = list(document['emits'])[0];
        if (
            handle === null || typeof handle !== 'object' || emit === null || typeof emit !== 'object' ||
            !('aggregate' in (handle as RawDocument)) || !('aggregate' in (emit as RawDocument))
        ) {
            continue; // only aggregate-bound handle/emit are supported for now
        }
        const handleRec = handle as RawDocument;
        const emitRec = emit as RawDocument;

        policies.push(
            new Policy(
                String(document['name']),
                domainName,
                String(handleRec['boundedContext'] ?? 'default'),
                String(handleRec['aggregate']),
                String(handleRec['event'] ?? ''),
                String(emitRec['boundedContext'] ?? 'default'),
                String(emitRec['aggregate']),
                String(emitRec['command'] ?? ''),
            ),
        );
    }

    return policies;
};

const parseFeatures = (featureDocs: RawDocument[], domainName: string): Feature[] => {
    const features: Feature[] = [];
    for (const document of featureDocs) {
        const scope = record(document['scope']);
        if (!('aggregate' in scope)) {
            continue; // only the aggregate variant is supported for now
        }

        const scenarios = list(document['scenarios']).map((raw) => {
            const scenario = record(raw);
            const when = record(scenario['when']);
            const then = record(scenario['then']);

            return new Scenario(
                String(scenario['name'] ?? ''),
                parseExamples(scenario['given']),
                String(when['command'] ?? ''),
                record(when['data']),
                parseExamples(then['events']),
                'rejection' in then ? String(record(then['rejection'])['reason'] ?? 'rejected') : null,
            );
        });

        features.push(
            new Feature(
                String(document['name']),
                domainName,
                String(scope['boundedContext'] ?? 'default'),
                String(scope['aggregate']),
                scenarios,
            ),
        );
    }

    return features;
};

const parseExamples = (raw: unknown): EventExample[] =>
    list(raw).map((entry) => {
        const example = record(entry);

        return new EventExample(String(example['event'] ?? ''), record(example['data']));
    });

const singleDomainName = (domainDocs: RawDocument[]): string => {
    if (domainDocs.length === 0) {
        throw new Error('Model contains no `domain` document.');
    }

    return String(domainDocs[0]['name']);
};

const schemaWithIdentity = (schema: Schema, identityField: string): Schema =>
    new Schema(schema.fields.map((f: Field) => f.withIdentity(f.name === identityField)));

const annotation = (document: RawDocument, key: string): string | null => {
    const value = record(record(document['metadata'])['annotations'])[key];

    return value == null ? null : String(value);
};

const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);
