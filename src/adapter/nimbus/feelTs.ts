import type { FeelNode } from '../../feel/feel.ts';
import { camel } from '../../support/str.ts';
import { literal } from './types.ts';
import { q } from './quote.ts';

/** Compiles a FEEL AST node to a TypeScript boolean expression over `state`. */
export const compileFeelToTs = (node: FeelNode): string => {
    switch (node.t) {
        case 'or':
            return `(${compileFeelToTs(node.l)} || ${compileFeelToTs(node.r)})`;
        case 'and':
            return `(${compileFeelToTs(node.l)} && ${compileFeelToTs(node.r)})`;
        case 'not':
            return `!(${compileFeelToTs(node.e)})`;
        case 'bin':
            return `(${compileFeelToTs(node.l)} ${tsOperator(node.op)} ${compileFeelToTs(node.r)})`;
        case 'in':
            return `[${node.list.map((x) => compileFeelToTs(x)).join(', ')}].includes(${compileFeelToTs(node.e)})`;
        case 'id':
            // State fields are optional on the state type; the guard only runs on a
            // populated aggregate, so assert non-null to satisfy the type-checker
            // (runtime is unchanged — a missing field still compares falsy).
            return node.name === 'status' ? "(state.status ?? '')" : `state.${camel(node.name)}!`;
        case 'str':
            return q(String(node.v));
        case 'num':
            return literal(node.v);
        case 'bool':
            return node.v ? 'true' : 'false';
        case 'call':
            return node.fn === 'today' ? 'new Date().toISOString().slice(0, 10)' : 'new Date().toISOString()';
        default:
            return 'null';
    }
};

const tsOperator = (op: string): string => {
    switch (op) {
        case '=':
            return '===';
        case '!=':
            return '!==';
        default:
            return op;
    }
};
