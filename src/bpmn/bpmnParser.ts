import { XMLParser } from 'fast-xml-parser';

/**
 * Parses BPMN 2.0 XML (as produced by bpmn-js / Camunda Modeler) into a plain
 * structure the {@link mapBpmnToEsdm} mapper consumes. Namespace-agnostic: it
 * matches by element local-name, so `bpmn:task` and `task` both work, and it
 * ignores diagram-interchange (`bpmndi`) entirely — only the semantic model is
 * read.
 *
 * ESDM-specific authoring hints ride in `extensionElements` as `<esdm:meta .../>`
 * (attributes become a key/value map) and `<esdm:field name=".." type=".."/>`
 * elements; `<camunda:property name value>` / `<property>` are read too so the
 * bpmn-js properties panel can drive the same mapping.
 */

export interface BpmnField {
    name: string;
    type: string;
}

export interface BpmnNode {
    id: string;
    name: string;
    kind: 'task' | 'event' | 'gateway';
    subtype: string;
    meta: Record<string, string>;
    fields: BpmnField[];
}

export interface BpmnFlow {
    id: string;
    source: string;
    target: string;
    name: string;
    condition: string | null;
}

export interface BpmnLane {
    name: string;
    meta: Record<string, string>;
    refs: string[];
}

export interface BpmnProcess {
    id: string;
    name: string;
    context: string | null;
    aggregate: string | null;
    initial: string | null;
    nodes: Map<string, BpmnNode>;
    flows: BpmnFlow[];
    lanes: BpmnLane[];
}

export interface BpmnMessageFlow {
    source: string;
    target: string;
    name: string;
}

export interface ParsedBpmn {
    domain: string | null;
    processes: BpmnProcess[];
    messageFlows: BpmnMessageFlow[];
    unmapped: string[];
}

const TASK_TYPES = new Set([
    'task',
    'userTask',
    'serviceTask',
    'sendTask',
    'receiveTask',
    'businessRuleTask',
    'scriptTask',
    'manualTask',
    'callActivity',
]);

const EVENT_TYPES = new Set([
    'startEvent',
    'endEvent',
    'intermediateCatchEvent',
    'intermediateThrowEvent',
    'boundaryEvent',
]);

const GATEWAY_TYPES = new Set([
    'exclusiveGateway',
    'parallelGateway',
    'inclusiveGateway',
    'eventBasedGateway',
    'complexGateway',
]);

const NON_NODE_CHILDREN = new Set(['sequenceFlow', 'laneSet', 'extensionElements']);

/**
 * A minimal, namespace-stripped view over the fast-xml-parser `preserveOrder`
 * tree: element children keep their document order (essential — mixed task
 * subtypes must map in the order they were drawn) and direct text is captured.
 */
interface XmlElement {
    name: string;
    attributes: Record<string, string>;
    children: XmlElement[];
    text: string;
}

const ATTRIBUTES_KEY = ':@';
const TEXT_KEY = '#text';

const localName = (name: string): string => {
    const colon = name.indexOf(':');

    return colon === -1 ? name : name.slice(colon + 1);
};

const readAttributes = (raw: unknown): Record<string, string> => {
    const attributes: Record<string, string> = {};
    if (raw === null || typeof raw !== 'object') {
        return attributes;
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const name = key.startsWith('@_') ? key.slice(2) : key;
        if (name === 'xmlns' || name.startsWith('xmlns:')) {
            continue;
        }
        attributes[name] = value === null || value === undefined ? '' : String(value);
    }

    return attributes;
};

const readNodes = (raw: unknown): { children: XmlElement[]; text: string } => {
    const children: XmlElement[] = [];
    let text = '';
    if (!Array.isArray(raw)) {
        return { children, text };
    }
    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') {
            continue;
        }
        const record = entry as Record<string, unknown>;
        if (TEXT_KEY in record) {
            text += String(record[TEXT_KEY]);
            continue;
        }
        let tag = '';
        for (const key of Object.keys(record)) {
            if (key !== ATTRIBUTES_KEY) {
                tag = key;
                break;
            }
        }
        if (tag === '') {
            continue;
        }
        const inner = readNodes(record[tag]);
        children.push({
            name: localName(tag),
            attributes: readAttributes(record[ATTRIBUTES_KEY]),
            children: inner.children,
            text: inner.text,
        });
    }

    return { children, text };
};

const childrenNamed = (element: XmlElement, name: string): XmlElement[] =>
    element.children.filter((child) => child.name === name);

/** Every descendant (document order, pre-order) with the given local name. */
const descendantsNamed = (root: XmlElement, name: string): XmlElement[] => {
    const found: XmlElement[] = [];
    const visit = (element: XmlElement): void => {
        for (const child of element.children) {
            if (child.name === name) {
                found.push(child);
            }
            visit(child);
        }
    };
    visit(root);

    return found;
};

/** Merge `source` into `target`, keeping any key already present (PHP `+=`). */
const mergeMissing = (target: Record<string, string>, source: Record<string, string>): void => {
    for (const [key, value] of Object.entries(source)) {
        if (!(key in target)) {
            target[key] = value;
        }
    }
};

const normalizeCondition = (raw: string): string => {
    let text = raw.trim();
    // Strip a camunda-style ${ ... } / #{ ... } expression wrapper.
    const match = text.match(/^[#$]\{([\s\S]*)\}$/);
    if (match !== null) {
        text = match[1].trim();
    }

    return text;
};

const parseProcess = (
    process: XmlElement,
    participantName: Record<string, string>,
    unmapped: string[],
): BpmnProcess => {
    const id = process.attributes['id'] ?? '';

    const meta: Record<string, string> = {};
    for (const ext of childrenNamed(process, 'extensionElements')) {
        for (const m of childrenNamed(ext, 'meta')) {
            mergeMissing(meta, m.attributes);
        }
    }

    const nodes = new Map<string, BpmnNode>();
    for (const child of process.children) {
        const local = child.name;
        const kind = TASK_TYPES.has(local)
            ? 'task'
            : EVENT_TYPES.has(local)
            ? 'event'
            : GATEWAY_TYPES.has(local)
            ? 'gateway'
            : null;
        if (kind === null) {
            if (!NON_NODE_CHILDREN.has(local)) {
                unmapped.push(`${local} "${child.attributes['id'] ?? ''}"`);
            }
            continue;
        }

        const nodeMeta: Record<string, string> = {};
        const fields: BpmnField[] = [];
        for (const ext of childrenNamed(child, 'extensionElements')) {
            for (const item of ext.children) {
                if (item.name === 'meta') {
                    mergeMissing(nodeMeta, item.attributes);
                } else if (item.name === 'field') {
                    fields.push({
                        name: item.attributes['name'] ?? '',
                        type: item.attributes['type'] || 'string',
                    });
                } else if (item.name === 'property') {
                    const name = item.attributes['name'] ?? '';
                    if (name !== '') {
                        nodeMeta[name] = item.attributes['value'] ?? '';
                    }
                }
            }
        }

        const nodeId = child.attributes['id'] ?? '';
        nodes.set(nodeId, {
            id: nodeId,
            name: child.attributes['name'] ?? '',
            kind,
            subtype: local,
            meta: nodeMeta,
            fields,
        });
    }

    const flows: BpmnFlow[] = [];
    for (const flow of childrenNamed(process, 'sequenceFlow')) {
        let condition: string | null = null;
        for (const cond of childrenNamed(flow, 'conditionExpression')) {
            condition = normalizeCondition(cond.text);
        }
        flows.push({
            id: flow.attributes['id'] ?? '',
            source: flow.attributes['sourceRef'] ?? '',
            target: flow.attributes['targetRef'] ?? '',
            name: flow.attributes['name'] ?? '',
            condition,
        });
    }

    const lanes: BpmnLane[] = [];
    for (const lane of descendantsNamed(process, 'lane')) {
        const laneMeta: Record<string, string> = {};
        for (const ext of childrenNamed(lane, 'extensionElements')) {
            for (const m of childrenNamed(ext, 'meta')) {
                mergeMissing(laneMeta, m.attributes);
            }
        }
        const refs: string[] = [];
        for (const ref of childrenNamed(lane, 'flowNodeRef')) {
            refs.push(ref.text.trim());
        }
        lanes.push({ name: lane.attributes['name'] ?? '', meta: laneMeta, refs });
    }

    const rawName = process.attributes['name'] ?? '';

    return {
        id,
        name: rawName !== '' ? rawName : (participantName[id] ?? id),
        context: meta['context'] ?? participantName[id] ?? null,
        aggregate: meta['aggregate'] ?? null,
        initial: meta['initial'] ?? null,
        nodes,
        flows,
        lanes,
    };
};

export const parseBpmn = (xml: string): ParsedBpmn => {
    const parser = new XMLParser({
        preserveOrder: true,
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: false,
        parseAttributeValue: false,
        trimValues: true,
        processEntities: true,
    });

    let tree: unknown;
    try {
        tree = parser.parse(xml);
    } catch (e) {
        throw new Error(`Could not parse BPMN XML: ${(e as Error).message}`);
    }

    const top = readNodes(tree);
    const root = top.children.find((child) => child.name === 'definitions') ??
        top.children.find((child) => child.children.length > 0) ??
        top.children[0];
    if (root === undefined) {
        throw new Error('Could not parse BPMN XML.');
    }

    // collaboration: participant (pool) name per processRef — the context name.
    const participantName: Record<string, string> = {};
    for (const participant of descendantsNamed(root, 'participant')) {
        const ref = participant.attributes['processRef'] ?? '';
        if (ref !== '') {
            participantName[ref] = participant.attributes['name'] ?? '';
        }
    }

    const definitionsMeta: Record<string, string> = {};
    for (const ext of childrenNamed(root, 'extensionElements')) {
        for (const meta of childrenNamed(ext, 'meta')) {
            mergeMissing(definitionsMeta, meta.attributes);
        }
    }

    const unmapped: string[] = [];
    const processes: BpmnProcess[] = [];
    for (const process of descendantsNamed(root, 'process')) {
        processes.push(parseProcess(process, participantName, unmapped));
    }

    // Message flows across pools become ESDM policies (event in A → command in B).
    const messageFlows: BpmnMessageFlow[] = [];
    for (const flow of descendantsNamed(root, 'messageFlow')) {
        messageFlows.push({
            source: flow.attributes['sourceRef'] ?? '',
            target: flow.attributes['targetRef'] ?? '',
            name: flow.attributes['name'] ?? '',
        });
    }

    return {
        domain: definitionsMeta['domain'] ?? null,
        processes,
        messageFlows,
        unmapped,
    };
};
