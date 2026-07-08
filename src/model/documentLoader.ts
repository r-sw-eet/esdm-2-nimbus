import { parse } from '@std/yaml';

export type RawDocument = Record<string, unknown>;

/**
 * Loads ESDM YAML files (one or many documents per file, separated by `---`)
 * from a directory tree into raw plain objects.
 */
export const loadDirectory = async (directory: string): Promise<RawDocument[]> => {
    let info: Deno.FileInfo;
    try {
        info = await Deno.stat(directory);
    } catch {
        throw new Error(`Model directory "${directory}" does not exist.`);
    }
    if (!info.isDirectory) {
        throw new Error(`Model directory "${directory}" does not exist.`);
    }

    const files: string[] = [];
    await collectYamlFiles(directory, files);
    files.sort();

    const documents: RawDocument[] = [];
    for (const file of files) {
        for (const raw of splitDocuments(await Deno.readTextFile(file))) {
            const parsed = parse(raw);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const record = parsed as RawDocument;
                if (Object.keys(record).length > 0) {
                    documents.push(record);
                }
            }
        }
    }

    return documents;
};

const collectYamlFiles = async (directory: string, files: string[]): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory) {
            await collectYamlFiles(path, files);
        } else if (entry.isFile && /\.(esdm\.ya?ml|ya?ml)$/.test(entry.name)) {
            files.push(path);
        }
    }
};

const splitDocuments = (content: string): string[] =>
    content
        .split(/^---[^\S\n]*$/m)
        .map((part) => part.trim())
        .filter((part) => part !== '');
