import { parseArgs } from '@std/cli';
import { parse, stringify } from '@std/yaml';
import { parseBpmn, type ParsedBpmn } from '../bpmn/bpmnParser.ts';
import { mapBpmnToEsdm } from '../bpmn/bpmnToEsdm.ts';

/**
 * `bpmn:map <app-dir>` — proposal 0003. Reads BPMN authored under the app's
 * `authoring/` directory and emits ESDM (core + 0001 + 0002) into its `model/`
 * directory, ready for `generate`. BPMN is the human source of truth; ESDM is
 * the generated intermediate representation.
 */
export const runBpmnMap = async (args: string[]): Promise<number> => {
    const flags = parseArgs(args, {
        string: ['authoring', 'model', 'domain'],
        alias: { a: 'authoring', m: 'model', d: 'domain' },
    });

    const appDir = String(flags._[0] ?? '.').replace(/\/+$/, '');

    let config: Record<string, unknown> = {};
    try {
        const parsed = parse(await Deno.readTextFile(`${appDir}/esdmgen.yaml`));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            config = parsed as Record<string, unknown>;
        }
    } catch {
        // no esdmgen.yaml — the fallback domain comes from the directory name
    }

    const options = (config['options'] ?? {}) as Record<string, unknown>;
    const fallbackDomain = String(flags.domain ?? options['appName'] ?? basename(appDir));

    const authoringDir = resolve(appDir, String(flags.authoring ?? 'authoring'));
    const modelDir = resolve(appDir, String(flags.model ?? 'model'));

    const bpmnFiles = await findBpmn(authoringDir);
    if (bpmnFiles.length === 0) {
        error(`No .bpmn files found under ${authoringDir}.`);

        return 1;
    }

    console.log(`\nMapping ${bpmnFiles.length} BPMN file(s) to ESDM\n`);

    // Parse every file and merge their processes into one model.
    const combined: ParsedBpmn = { domain: null, processes: [], messageFlows: [], unmapped: [] };
    for (const file of bpmnFiles) {
        const parsed = parseBpmn(await Deno.readTextFile(file));
        combined.domain ??= parsed.domain;
        combined.processes.push(...parsed.processes);
        combined.messageFlows.push(...parsed.messageFlows);
        combined.unmapped.push(...parsed.unmapped);
        console.log(`  ${basename(file)} — ${parsed.processes.length} process(es)`);
    }

    const result = mapBpmnToEsdm(combined, fallbackDomain);

    await Deno.mkdir(modelDir, { recursive: true });

    const corePath = `${modelDir}/${result.domain}.esdm.yaml`;
    await Deno.writeTextFile(corePath, dumpDocuments(result.documents));
    console.log(`  wrote ${corePath} (${result.documents.length} documents)`);

    for (const machine of result.stateMachines) {
        const path = `${modelDir}/${machine.aggregate}.statemachine.yaml`;
        await Deno.writeTextFile(path, dumpDocuments([machine.document]));
        console.log(`  wrote ${path}`);
    }

    for (const note of result.notes) {
        console.warn(`  [WARN] ${note}`);
    }

    console.log(`\n[OK] Mapped to ESDM in ${modelDir}. Run: deno task gen ${appDir}`);

    return 0;
};

const dumpDocuments = (documents: Record<string, unknown>[]): string =>
    documents.map((document) => stringify(document).trimEnd()).join('\n---\n') + '\n';

const findBpmn = async (directory: string): Promise<string[]> => {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        try {
            for await (const entry of Deno.readDir(dir)) {
                const path = `${dir}/${entry.name}`;
                if (entry.isDirectory) {
                    await walk(path);
                } else if (entry.isFile && entry.name.endsWith('.bpmn')) {
                    files.push(path);
                }
            }
        } catch {
            // directory missing or unreadable — treat as no files
        }
    };
    await walk(directory);
    files.sort();

    return files;
};

const basename = (path: string): string => {
    const trimmed = path.replace(/\/+$/, '');
    const slash = trimmed.lastIndexOf('/');

    return slash === -1 ? trimmed : trimmed.slice(slash + 1);
};

const resolve = (appDir: string, path: string): string => (path.startsWith('/') ? path : `${appDir}/${path}`);

const error = (message: string): void => {
    console.error(`\n[ERROR] ${message}`);
};
