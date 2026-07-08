import type { Field } from '../../model/types.ts';

/** Maps JSON-Schema types to TypeScript type hints, Zod schemas, literals and Mongo bson types. */

export const tsType = (field: Field): string => {
    switch (field.jsonType) {
        case 'string':
            return 'string';
        case 'boolean':
            return 'boolean';
        case 'integer':
        case 'number':
            return 'number';
        case 'array':
            return 'unknown[]';
        case 'object':
            return 'Record<string, unknown>';
        default:
            return 'unknown';
    }
};

/** A Zod schema expression for a single field's value. */
export const zod = (field: Field): string => {
    switch (field.jsonType) {
        case 'string':
            return 'z.string()';
        case 'boolean':
            return 'z.boolean()';
        case 'integer':
            return 'z.number().int()';
        case 'number':
            return 'z.number()';
        case 'array':
            return 'z.array(z.unknown())';
        case 'object':
            return 'z.record(z.string(), z.unknown())';
        default:
            return 'z.unknown()';
    }
};

/** zod() plus the model-declared default — an absent field then parses to it (replay-safe). */
export const zodWithDefault = (field: Field): string => {
    if (!field.hasDefault) {
        return zod(field);
    }

    return `${zod(field)}.default(${defaultLiteral(field)})`;
};

export const defaultLiteral = (field: Field): string => {
    if (field.hasDefault) {
        return literal(field.default_);
    }

    switch (field.jsonType) {
        case 'string':
            return "''";
        case 'boolean':
            return 'false';
        case 'integer':
        case 'number':
            return '0';
        case 'array':
            return '[]';
        case 'object':
            return '{}';
        default:
            return 'null';
    }
};

/** A TypeScript literal for an arbitrary value (used for FEEL constants and defaults). */
export const literal = (value: unknown): string => {
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (value === null || value === undefined) {
        return 'null';
    }
    if (typeof value === 'number') {
        return String(value);
    }

    return JSON.stringify(value);
};

export const bsonType = (field: Field): string => {
    switch (field.jsonType) {
        case 'boolean':
            return 'bool';
        case 'integer':
            return 'int';
        case 'number':
            return 'double';
        case 'array':
            return 'array';
        case 'object':
            return 'object';
        default:
            return 'string';
    }
};
