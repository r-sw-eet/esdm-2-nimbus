# Examples

Self-contained example apps for this generator — one directory per model. Each
`examples/<app>/` holds the **source**: `model/*.esdm.yaml` (+ `*.statemachine.yaml`
and FEEL guards), an optional `authoring/*.bpmn`, and an `esdmgen.yaml` targeting
`nimbus-eventsourcingdb`. The models are codegen-neutral — keep them in sync with the
equivalent apps in any other ESDM codegen.

Generate each app's runnable Nimbus + EventSourcingDB + MongoDB output into its own
**gitignored** `generated/` subdir:

```sh
deno task examples            # generate all → examples/<app>/generated/nimbus/
scripts/examples.sh --check   # smoke gate: temp dir, fail loudly, write nothing
```

`generated/` is disposable — never edit it by hand; change the model and regenerate.
