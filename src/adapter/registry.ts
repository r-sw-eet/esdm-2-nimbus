import { NimbusEventSourcingDbAdapter } from './nimbus/nimbusAdapter.ts';
import type { Adapter } from './adapter.ts';

export class AdapterRegistry {
    private readonly adapters = new Map<string, Adapter>();

    static withDefaults(): AdapterRegistry {
        const registry = new AdapterRegistry();
        registry.register(new NimbusEventSourcingDbAdapter());

        return registry;
    }

    register(adapter: Adapter): void {
        this.adapters.set(adapter.name(), adapter);
    }

    get(name: string): Adapter {
        const adapter = this.adapters.get(name);
        if (adapter === undefined) {
            throw new Error(`Unknown target "${name}". Available: ${[...this.adapters.keys()].join(', ')}.`);
        }

        return adapter;
    }

    all(): Adapter[] {
        return [...this.adapters.values()];
    }
}
