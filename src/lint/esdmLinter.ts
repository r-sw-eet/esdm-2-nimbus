/**
 * Validates an ESDM model against the canonical schema by shelling out to the
 * upstream `esdm` CLI. The generator's own parser is intentionally lax;
 * this is the gate that keeps an invalid model from reaching code generation.
 */

/** A single finding from `esdm lint --format json`. */
export class LintFinding {
    constructor(
        readonly ruleId: string,
        readonly severity: string,
        readonly message: string,
        readonly file: string | null,
        readonly line: number | null,
        readonly column: number | null,
    ) {}

    static fromRaw(raw: Record<string, unknown>): LintFinding {
        const location = (raw['location'] ?? {}) as Record<string, unknown>;

        return new LintFinding(
            String(raw['ruleId'] ?? 'unknown'),
            String(raw['severity'] ?? 'error'),
            String(raw['message'] ?? ''),
            location['file'] != null ? String(location['file']) : null,
            location['line'] != null ? Number(location['line']) : null,
            location['column'] != null ? Number(location['column']) : null,
        );
    }

    isError(): boolean {
        return this.severity === 'error';
    }

    location(): string {
        if (this.file === null) {
            return '';
        }

        return this.line === null ? this.file : `${this.file}:${this.line}:${this.column ?? 0}`;
    }
}

/** Outcome of an `esdm lint` run: the findings, split by severity. */
export class LintResult {
    constructor(readonly findings: LintFinding[]) {}

    errors(): LintFinding[] {
        return this.findings.filter((f) => f.isError());
    }

    warnings(): LintFinding[] {
        return this.findings.filter((f) => !f.isError());
    }

    hasErrors(): boolean {
        return this.errors().length > 0;
    }

    isClean(): boolean {
        return this.findings.length === 0;
    }
}

export class EsdmLinter {
    private resolved: string | false | null = null;

    constructor(private readonly binary: string | null = null) {}

    isAvailable(): boolean {
        return this.resolveBinary() !== null;
    }

    /** Resolved path to the `esdm` binary, or a hint of where it was looked for. */
    binaryHint(): string {
        return this.resolveBinary() ?? 'esdm (not found on PATH, ESDM_BIN, or tools/esdm)';
    }

    async lint(modelDir: string): Promise<LintResult> {
        const bin = this.resolveBinary();
        if (bin === null) {
            throw new Error(
                'esdm binary not found. Install it (https://www.esdm.io/getting-started/installing-esdm/), ' +
                    'put it at tools/esdm, or set the ESDM_BIN environment variable.',
            );
        }

        const output = await new Deno.Command(bin, {
            args: ['lint', '-d', modelDir, '--format', 'json', '--color', 'never'],
            stdout: 'piped',
            stderr: 'piped',
        }).output();

        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);

        let decoded: unknown;
        try {
            decoded = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
        } catch {
            decoded = null;
        }
        if (!Array.isArray(decoded)) {
            throw new Error(
                `esdm lint did not return parseable JSON (exit ${output.code}): ` +
                    (stderr.trim() !== '' ? stderr.trim() : stdout.trim()),
            );
        }

        const findings = decoded
            .filter((raw): raw is Record<string, unknown> => raw !== null && typeof raw === 'object')
            .map((raw) => LintFinding.fromRaw(raw));

        return new LintResult(findings);
    }

    private resolveBinary(): string | null {
        if (this.resolved !== null) {
            return this.resolved === false ? null : this.resolved;
        }

        for (const candidate of this.candidates()) {
            if (candidate !== null && isExecutableFile(candidate)) {
                this.resolved = candidate;

                return candidate;
            }
        }

        const onPath = findOnPath('esdm');
        this.resolved = onPath ?? false;

        return onPath;
    }

    private candidates(): (string | null)[] {
        const env = Deno.env.get('ESDM_BIN');

        return [
            this.binary,
            env !== undefined && env !== '' ? env : null,
            new URL('../../tools/esdm', import.meta.url).pathname,
        ];
    }
}

const isExecutableFile = (path: string): boolean => {
    try {
        const info = Deno.statSync(path);

        return info.isFile && (info.mode === null || (info.mode & 0o111) !== 0);
    } catch {
        return false;
    }
};

const findOnPath = (name: string): string | null => {
    const path = Deno.env.get('PATH') ?? '';
    for (const dir of path.split(':')) {
        if (dir === '') {
            continue;
        }
        const candidate = `${dir.replace(/\/+$/, '')}/${name}`;
        if (isExecutableFile(candidate)) {
            return candidate;
        }
    }

    return null;
};
