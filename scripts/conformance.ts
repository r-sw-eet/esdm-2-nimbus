/**
 * C4 conformance runner for the nimbus targets — implements the runner contract in
 * ../esdm-extensions/conformance/README.md: generate own targets from the canonical
 * model, boot, execute the scenario, normalize, compare against the golden answers.
 *
 * Usage: deno run -A scripts/conformance.ts <app> [--keep] [--skip-gen]
 */
import { parse as parseYaml, stringify as stringifyYaml } from '@std/yaml';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const WS = REPO.split('/').slice(0, -1).join('/');
const EXT = `${WS}/esdm-extensions/conformance`;
const WORK = `${REPO}/.c4work`;

const TARGETS: Record<string, { target: string; slug: string; port: number }> = {
    'nimbus': { target: 'nimbus-eventsourcingdb', slug: 'nimbus', port: 18110 },
    'nimbus-postgres': { target: 'nimbus-postgres', slug: 'nimbus-postgres', port: 18111 },
};
const API_INTERNAL = 3100;
const READY_TIMEOUT = 600_000;
const CONVERGE_TIMEOUT = 90_000;

const log = (msg: string) => console.log(`[c4:esdm-2-nimbus] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sh(args: string[], cwd?: string): Promise<void> {
    const out = await new Deno.Command(args[0], { args: args.slice(1), cwd, stdout: 'piped', stderr: 'piped' }).output();
    if (!out.success) {
        throw new Error(`command failed: ${args.join(' ')}\n${new TextDecoder().decode(out.stderr).slice(-800)}`);
    }
}

async function http(port: number, method: string, path: string, body?: unknown): Promise<[number, unknown]> {
    const res = await fetch(`http://127.0.0.1:${port}/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    try {
        return [res.status, raw ? JSON.parse(raw) : null];
    } catch {
        return [res.status, raw];
    }
}

// deno-lint-ignore no-explicit-any
type Json = any;

function resolve(value: Json, captures: Record<string, string>): Json {
    if (typeof value === 'string') {
        let v = value;
        for (const [k, val] of Object.entries(captures)) v = v.replaceAll(`$${k}`, val);
        return v;
    }
    if (Array.isArray(value)) return value.map((v) => resolve(v, captures));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, captures)]));
    }
    return value;
}

/** Canonical JSON: lexicographically sorted object keys (the comparison base). */
function canonical(value: Json): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    return JSON.stringify(value) ?? 'null';
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const canonEvent = (n: string) => (n.split('.').pop() ?? '').replaceAll('_', '-').toLowerCase();

function normalize(value: Json, idmap: Record<string, string>): Json {
    if (typeof value === 'string') return idmap[value] ?? value;
    if (Array.isArray(value)) return value.map((v) => normalize(v, idmap));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [camel(k), normalize(v, idmap)]));
    }
    return value;
}

const sortRows = (rows: Json[]) => [...rows].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);

interface Record_ {
    step?: string;
    checkpoint?: string;
    endpoint: string;
    status: number;
    body: Json;
}

async function runSteps(port: number, steps: Json[]): Promise<[Record_[], Record<string, string>]> {
    const captures: Record<string, string> = {};
    const out: Record_[] = [];
    for (const step of steps) {
        if (step.get !== undefined) {
            const deadline = Date.now() + (step.poll_timeout ?? 45) * 1000;
            let status = 0, resp: Json = null;
            while (true) {
                [status, resp] = await http(port, 'GET', resolve(step.get, captures));
                const ok = Array.isArray(resp) && resp.length >= (step.min_rows ?? 1);
                if (!step.poll || ok || Date.now() > deadline) break;
                await sleep(1000);
            }
            if (step.capture !== undefined && Array.isArray(resp) && resp.length > 0) {
                const field = step.capture_field ?? 'id';
                const rows = sortRows(resp.filter((r) => r !== null && typeof r === 'object'));
                const taken = new Set(Object.values(captures));
                const fresh = rows.filter((r) => !taken.has(r[field]));
                const val = (fresh.length ? fresh : rows)[0][field];
                if (typeof val === 'string') captures[step.capture] = val;
            }
            out.push({ step: step.name, endpoint: `GET ${step.get}`, status, body: resp });
            continue;
        }
        const body = resolve(step.body ?? null, captures);
        const [status, resp] = await http(port, 'POST', step.post, body);
        if (step.capture !== undefined && resp !== null && typeof resp === 'object' && typeof resp.id === 'string') {
            captures[step.capture] = resp.id;
        }
        out.push({ step: step.name, endpoint: `POST ${step.post}`, status, body: resp });
    }
    return [out, captures];
}

async function readCheckpoints(port: number, checkpoints: Json[], captures: Record<string, string>): Promise<Record_[]> {
    const out: Record_[] = [];
    for (const cp of checkpoints) {
        const [status, resp] = await http(port, 'GET', resolve(cp.get, captures));
        out.push({ checkpoint: cp.name, endpoint: `GET ${cp.get}`, status, body: resp });
    }
    return out;
}

async function converge(port: number, checkpoints: Json[], captures: Record<string, string>): Promise<Record_[]> {
    let stable = 0, last: string | null = null;
    const deadline = Date.now() + CONVERGE_TIMEOUT;
    while (Date.now() < deadline) {
        const snap = canonical(await readCheckpoints(port, checkpoints, captures));
        if (snap === last) {
            if (++stable >= 2) return await readCheckpoints(port, checkpoints, captures);
        } else {
            stable = 0;
            last = snap;
        }
        await sleep(1000);
    }
    log(`WARN: checkpoints did not stabilize in ${CONVERGE_TIMEOUT / 1000}s`);
    return await readCheckpoints(port, checkpoints, captures);
}

function normalizeAll(steps: Record_[], checkpoints: Record_[], captures: Record<string, string>) {
    const idmap: Record<string, string> = {};
    for (const [k, v] of Object.entries(captures)) idmap[v] = `«${k}»`;
    const nsteps = steps.map((o) => {
        let body = normalize(o.body, idmap);
        if (Array.isArray(body)) body = sortRows(body);
        return { ...o, body };
    });
    const ncps = checkpoints.map((o) => {
        let body = o.body;
        if (o.checkpoint === 'events') {
            body = (Array.isArray(body) ? body : []).map((r: Json) => ({
                aggregate: String(r.aggregate ?? '').toLowerCase(),
                aggregateId: idmap[r.aggregate_id] ?? r.aggregate_id ?? null,
                event: canonEvent(String(r.event ?? '')),
                playhead: r.playhead ?? null,
                payload: normalize(r.payload ?? null, idmap),
            }));
        } else {
            body = normalize(body, idmap);
            if (Array.isArray(body)) body = sortRows(body);
        }
        return { ...o, body };
    });
    return { steps: nsteps, checkpoints: ncps };
}

function flatten(prefix: string, value: Json, out: Record<string, string>): void {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            out[prefix] = '[]';
            return;
        }
        value.forEach((v, i) => flatten(`${prefix}[${i}]`, v, out));
        return;
    }
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) {
            out[prefix] = '{}';
            return;
        }
        for (const k of keys) flatten(prefix === '' ? k : `${prefix}.${k}`, value[k], out);
        return;
    }
    out[prefix] = canonical(value);
}

function fnmatch(pattern: string, s: string): boolean {
    const rx = '^' + pattern.replace(/[.+^${}()|\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$';
    return new RegExp(rx).test(s);
}

function compare(mine: Json, golden: Json, registry: Json[], target: string) {
    const failures: Json[] = [];
    const accepted: Json[] = [];
    for (const [kind, nameKey] of [['steps', 'step'], ['checkpoints', 'checkpoint']] as const) {
        golden[kind].forEach((g: Json, i: number) => {
            const m = mine[kind][i] ?? { status: null, body: null };
            const endpoint = `${g.endpoint}#${g[nameKey]}`;
            const fg: Record<string, string> = {};
            const fm: Record<string, string> = {};
            flatten('', { status: g.status, body: g.body }, fg);
            flatten('', { status: m.status, body: m.body }, fm);
            for (const field of [...new Set([...Object.keys(fg), ...Object.keys(fm)])].sort()) {
                const a = field in fg ? fg[field] : '<absent>';
                const b = field in fm ? fm[field] : '<absent>';
                if (a === b) continue;
                const entry = { endpoint, field, golden: a, got: b };
                const reg = registry.find((r: Json) =>
                    (!r.targets || r.targets.includes(target)) && fnmatch(r.endpoint, endpoint) && fnmatch(r.field, field)
                );
                (reg ? accepted : failures).push(entry);
            }
        });
    }
    return { failures, accepted };
}

// ---------------------------------------------------------------- main

const args = Deno.args.filter((a) => !a.startsWith('--'));
const flags = new Set(Deno.args.filter((a) => a.startsWith('--')));
const app = args[0];
if (!app) {
    console.error('usage: deno run -A scripts/conformance.ts <app> [--keep] [--skip-gen]');
    Deno.exit(2);
}

const scenario = parseYaml(await Deno.readTextFile(`${EXT}/scenarios/${app}.yaml`)) as Json;
const registry = ((parseYaml(await Deno.readTextFile(`${EXT}/registry.yaml`)) as Json)?.divergences ?? []) as Json[];
const golden = JSON.parse(await Deno.readTextFile(`${EXT}/golden/${app}.observations.json`));

let exitCode = 0;
for (const [tname, tcfg] of Object.entries(TARGETS)) {
    if (!scenario.targets.includes(tname)) {
        log(`${tname}: not in scenario targets — skipped`);
        continue;
    }
    const appdir = `${WORK}/${app}/${tname}`;
    const stack = `${appdir}/generated/${tcfg.slug}`;
    const project = `c4-esdm-2-nimbus-${app}-${tname}`;
    const port = tcfg.port;

    if (!flags.has('--skip-gen')) {
        await Deno.remove(appdir, { recursive: true }).catch(() => {});
        await Deno.mkdir(appdir, { recursive: true });
        log(`${tname}: generating`);
        await sh(['deno', 'task', 'gen', appdir, '--target', tcfg.target, '--model', `${WS}/${scenario.model}`, '--out', `${appdir}/generated`], REPO);
        const compose = parseYaml(await Deno.readTextFile(`${stack}/compose.yaml`)) as Json;
        for (const [name, svc] of Object.entries<Json>(compose.services ?? {})) {
            if (name === 'api') svc.ports = [`127.0.0.1:${port}:${API_INTERNAL}`];
            else delete svc.ports;
        }
        await Deno.writeTextFile(`${stack}/compose.yaml`, stringifyYaml(compose));
    }

    try {
        log(`${tname}: booting on :${port}`);
        await sh(['docker', 'compose', '-p', project, '-f', `${stack}/compose.yaml`, 'up', '-d', '--build', '--quiet-pull']);
        const deadline = Date.now() + READY_TIMEOUT;
        let ready = false;
        while (Date.now() < deadline) {
            try {
                if ((await http(port, 'GET', '_dev/catalog'))[0] === 200) {
                    ready = true;
                    break;
                }
            } catch { /* not up yet */ }
            await sleep(2000);
        }
        if (!ready) throw new Error(`${tname}: api not ready in ${READY_TIMEOUT / 1000}s`);
        log(`${tname}: running scenario`);
        const [steps, captures] = await runSteps(port, scenario.steps);
        const cps = await converge(port, scenario.checkpoints, captures);
        const mine = normalizeAll(steps, cps, captures);
        await Deno.writeTextFile(`${appdir}/observations.json`, JSON.stringify(mine, null, 2));
        const { failures, accepted } = compare(mine, golden, registry, tname);
        for (const d of accepted) log(`${tname}: registered divergence ${d.endpoint} ${d.field}`);
        for (const d of failures) log(`${tname}: FAIL ${d.endpoint} ${d.field}: golden=${d.golden} got=${d.got}`);
        log(`${tname}: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length} unregistered divergences)`}`);
        if (failures.length > 0) exitCode = 1;
    } finally {
        if (!flags.has('--keep')) {
            await sh(['docker', 'compose', '-p', project, '-f', `${stack}/compose.yaml`, 'down', '-v', '--remove-orphans']).catch((e) => log(`WARN teardown: ${e}`));
        }
    }
}
Deno.exit(exitCode);
