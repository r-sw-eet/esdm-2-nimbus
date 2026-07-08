import { FeelError, Token, tokenize } from './lexer.ts';

export type FeelNode =
    | { t: 'or'; l: FeelNode; r: FeelNode }
    | { t: 'and'; l: FeelNode; r: FeelNode }
    | { t: 'not'; e: FeelNode }
    | { t: 'bin'; op: string; l: FeelNode; r: FeelNode }
    | { t: 'in'; e: FeelNode; list: FeelNode[] }
    | { t: 'id'; name: string }
    | { t: 'str'; v: string }
    | { t: 'num'; v: number }
    | { t: 'bool'; v: boolean }
    | { t: 'call'; fn: 'today' | 'now' };

/**
 * Recursive-descent parser for the FEEL subset (proposal 0002). Produces a
 * discriminated-union AST. Precedence: or < and < comparison < primary.
 *
 * Supported: comparisons (= != < <= > >=), and/or/not(...), membership
 * (x in [a, b]), parentheses, string/number/boolean literals, identifiers
 * (field references) and the niladic functions today()/now().
 */
export const parseFeel = (source: string): FeelNode => {
    const parser = new Parser(tokenize(source));
    const ast = parser.parseOr();
    parser.expectType('eof');

    return ast;
};

class Parser {
    private i = 0;

    constructor(private readonly tokens: Token[]) {}

    private peek(): Token {
        return this.tokens[this.i];
    }

    private advance(): void {
        this.i++;
    }

    private at(value: string): boolean {
        return this.peek().value === value;
    }

    private isKeyword(keyword: string): boolean {
        const token = this.peek();

        return token.type === 'name' && token.value.toLowerCase() === keyword;
    }

    private eat(value: string): void {
        if (!this.at(value)) {
            throw new FeelError(`Expected "${value}", got "${this.peek().value}"`);
        }
        this.advance();
    }

    expectType(type: Token['type']): void {
        if (this.peek().type !== type) {
            throw new FeelError(`Expected ${type}, got "${this.peek().value}"`);
        }
    }

    parseOr(): FeelNode {
        let left = this.parseAnd();
        while (this.isKeyword('or')) {
            this.advance();
            left = { t: 'or', l: left, r: this.parseAnd() };
        }

        return left;
    }

    private parseAnd(): FeelNode {
        let left = this.parseComparison();
        while (this.isKeyword('and')) {
            this.advance();
            left = { t: 'and', l: left, r: this.parseComparison() };
        }

        return left;
    }

    private parseComparison(): FeelNode {
        const left = this.parsePrimary();
        const token = this.peek();

        if (token.type === 'op') {
            this.advance();

            return { t: 'bin', op: token.value, l: left, r: this.parsePrimary() };
        }

        if (this.isKeyword('in')) {
            this.advance();

            return { t: 'in', e: left, list: this.parseList() };
        }

        return left;
    }

    private parseList(): FeelNode[] {
        this.eat('[');
        const items: FeelNode[] = [];
        if (!this.at(']')) {
            items.push(this.parsePrimary());
            while (this.at(',')) {
                this.advance();
                items.push(this.parsePrimary());
            }
        }
        this.eat(']');

        return items;
    }

    private parsePrimary(): FeelNode {
        const token = this.peek();

        if (this.at('(')) {
            this.advance();
            const expr = this.parseOr();
            this.eat(')');

            return expr;
        }

        if (this.isKeyword('not')) {
            this.advance();
            this.eat('(');
            const expr = this.parseOr();
            this.eat(')');

            return { t: 'not', e: expr };
        }

        if (token.type === 'num') {
            this.advance();

            return { t: 'num', v: Number(token.value) };
        }

        if (token.type === 'str') {
            this.advance();

            return { t: 'str', v: token.value.slice(1, -1) };
        }

        if (token.type === 'name') {
            const name = token.value;
            const lower = name.toLowerCase();

            if (lower === 'true' || lower === 'false') {
                this.advance();

                return { t: 'bool', v: lower === 'true' };
            }

            if (lower === 'today' || lower === 'now') {
                this.advance();
                this.eat('(');
                this.eat(')');

                return { t: 'call', fn: lower };
            }

            this.advance();

            return { t: 'id', name };
        }

        throw new FeelError(`Unexpected token "${token.value}"`);
    }
}
