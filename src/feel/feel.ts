import type { FeelNode } from './parser.ts';

export { FeelError } from './lexer.ts';
export { type FeelNode, parseFeel } from './parser.ts';

/**
 * Binds identifiers against a set of allowed fields.
 * Returns the binding errors (empty = valid).
 */
export const validateFeel = (ast: FeelNode, allowedFields: string[]): string[] => {
    const errors: string[] = [];
    bind(ast, allowedFields, errors);

    return errors;
};

const bind = (node: FeelNode, allowed: string[], errors: string[]): void => {
    switch (node.t) {
        case 'id':
            if (!allowed.includes(node.name)) {
                errors.push(`unknown field "${node.name}"`);
            }
            break;
        case 'or':
        case 'and':
        case 'bin':
            bind(node.l, allowed, errors);
            bind(node.r, allowed, errors);
            break;
        case 'not':
            bind(node.e, allowed, errors);
            break;
        case 'in':
            bind(node.e, allowed, errors);
            for (const item of node.list) {
                bind(item, allowed, errors);
            }
            break;
    }
};
