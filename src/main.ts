import { AdapterRegistry } from './adapter/registry.ts';
import { runBpmnMap } from './cli/bpmnMap.ts';
import { runGenerate } from './cli/generate.ts';

const usage = `esdm-2-nimbus — ESDM → Nimbus code generator 0.1.0

Usage:
  deno task gen <app-dir> [--target <name>] [--model <dir>] [--out <dir>] [--skip-lint] [--strict]
  deno task map <app-dir> [--authoring <dir>] [--model <dir>] [--domain <name>]
  deno task targets
`;

const [command, ...rest] = Deno.args;

switch (command) {
    case 'generate': {
        Deno.exit(await runGenerate(rest));
        break;
    }
    case 'bpmn:map': {
        Deno.exit(await runBpmnMap(rest));
        break;
    }
    case 'targets': {
        for (const adapter of AdapterRegistry.withDefaults().all()) {
            console.log(`${adapter.name()}\n    ${adapter.description()}`);
        }
        break;
    }
    default: {
        console.log(usage);
        Deno.exit(command === undefined || command === 'help' ? 0 : 1);
    }
}
