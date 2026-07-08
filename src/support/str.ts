/**
 * Naming helpers. ESDM identifiers are kebab-case (^[a-z][a-z0-9-]*$); generated
 * code needs StudlyCase classes, camelCase members and snake_case table names.
 */

export const studly = (value: string): string =>
    value
        .split(/[-_ ]+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');

export const camel = (value: string): string => {
    const s = studly(value);

    return s.charAt(0).toLowerCase() + s.slice(1);
};

export const snake = (value: string): string =>
    value
        .replaceAll('-', '_')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();
