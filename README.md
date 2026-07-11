# esdm-2-nimbus

A Deno/TypeScript code generator that consumes an [ESDM](https://www.esdm.io/) model (core kinds plus the state-machine,
FEEL and BPMN-mapping extension proposals) and emits a complete, runnable event-sourced application on the **Nimbus**
(`@nimbus-cqrs`) stack, with a choice of event store: **[EventSourcingDB](https://www.eventsourcingdb.io/)** or
**[PostgreSQL](https://www.postgresql.org/)** (read models on **MongoDB** either way). A model can be written
directly as ESDM, or authored as BPMN and mapped down to ESDM first (proposal 0003).

It implements the [esdm-extensions](https://github.com/r-sw-eet/esdm-extensions) proposals and the
`esdm-extensions.io/*` annotation namespace, and is the sole owner of the `nimbus-eventsourcingdb` and
`nimbus-postgres` targets. It is
**self-contained** — it carries its own example models and depends on no sibling repo. The one external tool it needs
is the upstream `esdm` lint CLI (third-party, not bundled — see [Prerequisites](#prerequisites)).

## Stack

The generator itself runs on Deno; the **emitted** apps run on this stack (linked to upstream docs — no local doc mirror
is kept):

| Layer                | Technology                                                                                                        |
|----------------------|-------------------------------------------------------------------------------------------------------------------|
| Model / input format | [ESDM](https://www.esdm.io/) + [esdm-extensions](https://github.com/r-sw-eet/esdm-extensions) proposals 0001–0004 |
| Generator runtime    | [Deno](https://deno.com/) · [TypeScript](https://www.typescriptlang.org/)                                         |
| Generated app        | [Nimbus](https://nimbus.overlap.at/) (`@nimbus-cqrs`) · [Hono](https://hono.dev/) HTTP                            |
| Event store          | [EventSourcingDB](https://www.eventsourcingdb.io/) (`nimbus-eventsourcingdb`) or [PostgreSQL](https://www.postgresql.org/) (`nimbus-postgres`) |
| Read side            | [MongoDB](https://www.mongodb.com/) projections + query API                                                       |

## Pipeline

```
BPMN            ESDM YAML  ──esdm lint──▶  parse + wire model  ──FEEL gate──▶  Nimbus adapter  ──▶  generated/nimbus/
(authoring/) ─▶ (model/)     (structure)   (framework-agnostic)  (guards bind    (the only stack-
  bpmn:map                                                        to real fields) aware layer)
```

- **BPMN map** (optional, proposal 0003) — `bpmn:map` decomposes BPMN authored under `authoring/` into ESDM
  `model/*.yaml` (core + 0001 state machines + 0002 FEEL guards): each pool → a bounded-context + aggregate, each task →
  a command and its event, the sequence-flow graph → the lifecycle, cross-pool message flows → policies. ESDM remains
  the generator's input.
- **Lint gate** — shells out to the upstream `esdm` CLI (`ESDM_BIN`, `tools/esdm`, or `PATH`); an invalid model
  never reaches generation.
- **Model** — raw YAML documents are grouped by `kind` and wired into a resolved graph (command → event, event →
  aggregate, read model → events, query → read model, policy → both ends).
- **FEEL gate** — every state-machine `admits[].when` guard is parsed and its identifiers bound against the aggregate's
  declared state fields.
- **Adapter** — emits the write side (pure deciders with 0001/0002 guards compiled to TypeScript, event-store append
  with concurrency preconditions), the read side (MongoDB projections + query API), the app bootstrap (Hono HTTP,
  compose stack, Dockerfile), and the dev-only **domain-console contract** (proposal 0004: `/_dev/catalog|bpmn|events`)
  consumed by the stack-agnostic `esdm-vue-reader` viewer. Two targets share this emission and differ only in the
  store: `nimbus-eventsourcingdb` appends to EventSourcingDB and projects via Nimbus event observers;
  `nimbus-postgres` appends to a Postgres `eventstore` table (global order = the `id` bigint, unique
  `(aggregate, aggregate_id, playhead)` as the concurrency guard) and projects via a subscription engine with durable
  cursors in a `subscriptions` table — the same architecture as the sibling Symfony/patchlevel generator.

The model layer is framework-agnostic; `src/adapter/nimbus/` is the only place that knows the target stack. Generated
apps have **no manual-code seam** — reactions are `policy` documents in the model and external egress consumes the event
stream downstream, so you change behavior by changing the model and regenerating, never by hand-editing the output.

## Prerequisites

- **[Deno](https://deno.com/) 2.x** — the generator runtime. There is no `package.json` or `node_modules`: dependencies
  resolve from JSR/npm through Deno's global cache, pinned by the committed `deno.lock`. A clone just runs `deno task …`.
- **The upstream `esdm` CLI** — the lint gate shells out to it (`esdm lint`), so an invalid model never reaches
  generation. It's third-party and **not** committed to this repo. Easiest is to run **`scripts/fetch-esdm.sh`**, which
  downloads the pinned version into `tools/esdm` (gitignored) for your OS/arch and checksum-verifies it. Otherwise
  install it from the [esdm install guide](https://www.esdm.io/getting-started/installing-esdm/) and make it
  discoverable via `tools/esdm`, `ESDM_BIN=/path/to/esdm`, or `esdm` on your `PATH`. To generate without it at all, pass
  `--skip-lint` (this also skips the FEEL gate).

## Usage

```sh
# optional: author as BPMN, map authoring/*.bpmn → model/*.yaml first (proposal 0003)
deno task map path/to/app

# app dir contains esdmgen.yaml + model/*.esdm.yaml
deno task gen path/to/app --target nimbus-eventsourcingdb [--skip-lint] [--strict]
deno task gen path/to/app --target nimbus-postgres          # PostgreSQL event store instead of EventSourcingDB

# list targets
deno task targets
```

`--skip-lint` bypasses the `esdm` structural lint and the FEEL guard gate (use when the `esdm` binary is unavailable);
`--strict` promotes lint warnings to a hard failure.

`esdmgen.yaml`:

```yaml
target: nimbus-eventsourcingdb
model: model
out: generated
options:
    appName: my-app
```

Each target writes into its own subdirectory (`generated/nimbus/`, `generated/nimbus-postgres/`). Run the emitted app
with `docker compose up -d --build` inside that directory.

## Development

```sh
deno task test              # unit tests (model, FEEL, naming, adapter)
deno lint && deno fmt
scripts/examples.sh --check # smoke gate: generate every example app from examples/
```

## Layout

| Path                       | Role                                                              |
|----------------------------|-------------------------------------------------------------------|
| `src/model/`               | documentLoader, modelFactory, types — parse ESDM → resolved model |
| `src/feel/`                | FEEL lexer, parser, validator (proposal 0002)                     |
| `src/bpmn/`                | BPMN 2.0 → ESDM mapper (proposal 0003): parser + mapper           |
| `src/lint/esdmLinter.ts`   | the `esdm lint` gate                                              |
| `src/adapter/nimbus/`      | the only stack-aware layer — emits the Nimbus app                 |
| `src/cli/` + `src/main.ts` | CLI entrypoints (`generate`, `bpmn:map`)                          |
| `src/support/str.ts`       | naming helpers                                                    |
| `examples/`                | self-contained example models (source tracked, output gitignored) |

The `esdm-extensions.io/*` annotation namespace is owned by the
[esdm-extensions](https://github.com/r-sw-eet/esdm-extensions) spec repo, never by a codegen — contract changes (e.g.
the 0004 domain-console surface) go through a proposal amendment there first.

## License

MIT © 2026 Ralf Süss
