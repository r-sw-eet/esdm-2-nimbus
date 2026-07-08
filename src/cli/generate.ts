import { parseArgs } from '@std/cli';
import { parse } from '@std/yaml';
import { GeneratedProject } from '../adapter/adapter.ts';
import { AdapterRegistry } from '../adapter/registry.ts';
import { FeelError, parseFeel, validateFeel } from '../feel/feel.ts';
import { EsdmLinter, LintResult } from '../lint/esdmLinter.ts';
import { loadDirectory } from '../model/documentLoader.ts';
import { createModel } from '../model/modelFactory.ts';
import type { Model } from '../model/types.ts';

/**
 * `generate <app-dir>` — read the app's `esdmgen.yaml`, parse its ESDM model
 * and emit a project with the chosen target adapter.
 */
export const runGenerate = async (args: string[]): Promise<number> => {
    const flags = parseArgs(args, {
        string: ['target', 'model', 'out'],
        boolean: ['skip-lint', 'strict'],
        alias: { t: 'target', m: 'model', o: 'out' },
    });

    const appDir = String(flags._[0] ?? '.').replace(/\/+$/, '');

    let config: Record<string, unknown> = {};
    const configPath = `${appDir}/esdmgen.yaml`;
    try {
        const parsed = parse(await Deno.readTextFile(configPath));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            config = parsed as Record<string, unknown>;
        }
    } catch {
        // no esdmgen.yaml — flags must carry the configuration
    }

    const target = String(flags.target ?? config['target'] ?? '');
    const modelDir = resolve(appDir, String(flags.model ?? config['model'] ?? 'model'));
    let outDir = resolve(appDir, String(flags.out ?? config['out'] ?? 'generated'));
    const options = (config['options'] ?? {}) as Record<string, unknown>;

    if (target === '') {
        error('No target adapter given (set `target:` in esdmgen.yaml or pass --target).');

        return 1;
    }

    const lintConfig = (config['lint'] ?? {}) as Record<string, unknown>;
    const strict = Boolean(flags.strict || (lintConfig['strict'] ?? false));
    if (!flags['skip-lint'] && !(await lint(modelDir, strict))) {
        return 1;
    }

    console.log(`\nGenerating "${target}" from ${modelDir}\n`);

    const documents = await loadDirectory(modelDir);
    const model = createModel(documents);

    if (!flags['skip-lint'] && !validateModelFeel(model)) {
        return 1;
    }

    let adapter;
    try {
        adapter = AdapterRegistry.withDefaults().get(target);
    } catch (e) {
        error((e as Error).message);

        return 1;
    }

    // Each stack writes into its own subdir so multiple targets never collide.
    outDir = outDir.replace(/\/+$/, '') + '/' + adapter.slug();

    // Embed the app's BPMN (if any) so a console Author tab can load it.
    options['bpmnSource'] = await readBpmnSource(appDir);

    const project: GeneratedProject = adapter.generate(model, options);
    await project.writeTo(outDir);

    for (const path of project.files().keys()) {
        console.log(` * ${path}`);
    }
    console.log(`\n[OK] Wrote ${project.files().size} files to ${outDir}`);

    return 0;
};

/** The first BPMN file under the app's `authoring/` directory, if present. */
const readBpmnSource = async (appDir: string): Promise<string> => {
    const authoring = `${appDir}/authoring`;
    const files: string[] = [];
    try {
        for await (const entry of Deno.readDir(authoring)) {
            if (entry.isFile && entry.name.endsWith('.bpmn')) {
                files.push(`${authoring}/${entry.name}`);
            }
        }
    } catch {
        return '';
    }
    files.sort();

    return files.length === 0 ? '' : await Deno.readTextFile(files[0]);
};

/**
 * Run `esdm lint` as a gate before generation. An invalid model never
 * reaches the adapter — garbage in would only mean garbage out.
 */
const lint = async (modelDir: string, strict: boolean): Promise<boolean> => {
    const linter = new EsdmLinter();
    if (!linter.isAvailable()) {
        error(`Cannot validate the model: ${linter.binaryHint()}`);

        return false;
    }

    console.log(`\nLinting model in ${modelDir}\n`);

    let result: LintResult;
    try {
        result = await linter.lint(modelDir);
    } catch (e) {
        error((e as Error).message);

        return false;
    }

    render(result);

    if (result.hasErrors()) {
        error('Model is not valid ESDM — aborting before generation.');

        return false;
    }

    if (strict && result.warnings().length > 0) {
        error('Lint warnings present and --strict is set — aborting.');

        return false;
    }

    if (result.isClean()) {
        console.log('Model passes esdm lint cleanly.');
    }

    return true;
};

const render = (result: LintResult): void => {
    for (const finding of result.findings) {
        const location = finding.location() !== '' ? ` (${finding.location()})` : '';
        console.log(`  ${finding.isError() ? 'error' : 'warning'} ${finding.message}${location} [${finding.ruleId}]`);
    }
};

/**
 * Model-aware FEEL gate (proposal 0002): parse every state-machine guard
 * expression and bind its identifiers to real aggregate fields. Runs after
 * parse and before generation, complementing the structural `esdm lint`.
 */
const validateModelFeel = (model: Model): boolean => {
    const errors: string[] = [];
    for (const aggregate of model.aggregates()) {
        if (aggregate.stateMachine === null) {
            continue;
        }
        const allowed = aggregate.state.fields.map((field) => field.name);
        allowed.push('status');

        for (const admit of aggregate.stateMachine.admits) {
            if (admit.when === null || admit.when === '') {
                continue;
            }
            try {
                for (const bindError of validateFeel(parseFeel(admit.when), allowed)) {
                    errors.push(`${admit.command}.when "${admit.when}": ${bindError}`);
                }
            } catch (e) {
                if (!(e instanceof FeelError)) {
                    throw e;
                }
                errors.push(`${admit.command}.when "${admit.when}": ${e.message}`);
            }
        }
    }

    if (errors.length === 0) {
        return true;
    }

    console.log('\nFEEL validation\n');
    for (const feelError of errors) {
        console.log(`  error ${feelError}`);
    }
    error('FEEL guard expressions are invalid — aborting before generation.');

    return false;
};

const resolve = (appDir: string, path: string): string => (path.startsWith('/') ? path : `${appDir}/${path}`);

const error = (message: string): void => {
    console.error(`\n[ERROR] ${message}`);
};
