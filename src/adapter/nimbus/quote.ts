/** A single-quoted TypeScript string literal. */
export const q = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
