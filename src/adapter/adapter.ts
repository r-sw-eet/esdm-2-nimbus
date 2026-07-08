import type { Model } from '../model/types.ts';

/** An in-memory tree of files an adapter wants written, keyed by relative path. */
export class GeneratedProject {
    private readonly fileMap = new Map<string, string>();

    add(relativePath: string, contents: string): void {
        this.fileMap.set(relativePath.replace(/^\/+/, ''), contents);
    }

    files(): Map<string, string> {
        return this.fileMap;
    }

    async writeTo(directory: string): Promise<void> {
        for (const [relativePath, contents] of this.fileMap) {
            const target = `${directory.replace(/\/+$/, '')}/${relativePath}`;
            const dir = target.slice(0, target.lastIndexOf('/'));
            await Deno.mkdir(dir, { recursive: true });
            await Deno.writeTextFile(target, contents);
        }
    }
}

/**
 * A generation target: one framework + database + event-sourcing library combo
 * (e.g. nimbus-eventsourcingdb). Adapters are the *only* place that knows
 * about a concrete stack; everything upstream is framework-agnostic.
 */
export interface Adapter {
    /** Stable target id selected on the CLI with --target. */
    name(): string;

    description(): string;

    /** Short stack slug — the subdirectory each target writes into under `generated/`. */
    slug(): string;

    generate(model: Model, options: Record<string, unknown>): GeneratedProject;
}
