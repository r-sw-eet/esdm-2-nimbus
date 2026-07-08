/** A FEEL expression failed to lex, parse or bind. */
export class FeelError extends Error {}

export type Token = { type: 'num' | 'str' | 'name' | 'punc' | 'op' | 'eof'; value: string };

/** Tokenizes the supported FEEL subset. */
export const tokenize = (source: string): Token[] => {
    // Anchored, ordered alternation; longest operators first.
    const pattern = /(\s+)|(\d+(?:\.\d+)?)|("[^"]*")|(<=|>=|!=|=|<|>)|([()[\],])|([A-Za-z_][A-Za-z0-9_]*)/y;

    const tokens: Token[] = [];
    let offset = 0;

    while (offset < source.length) {
        pattern.lastIndex = offset;
        const m = pattern.exec(source);
        if (m === null) {
            throw new FeelError(`Unexpected character at ${offset}: "${source[offset]}"`);
        }
        const value = m[0];
        offset += value.length;

        if (value.trim() === '') {
            continue; // whitespace
        }

        const type: Token['type'] = /^\d/.test(value)
            ? 'num'
            : value[0] === '"'
            ? 'str'
            : /^[A-Za-z_]/.test(value)
            ? 'name'
            : ['(', ')', '[', ']', ','].includes(value)
            ? 'punc'
            : 'op';

        tokens.push({ type, value });
    }

    tokens.push({ type: 'eof', value: '' });

    return tokens;
};
