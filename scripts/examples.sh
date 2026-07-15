#!/usr/bin/env bash
# Generates every example app from THIS repo's own source models
# (examples/<app>/model, driven by examples/<app>/esdmgen.yaml). Self-contained:
# uses this repo's own tools/esdm lint binary — no sibling repo required.
#
# Two modes:
#   (default)  write each app's output into examples/<app>/generated/ (gitignored)
#   --check    smoke gate: generate into a temp dir and fail loudly on any error
#              or suspiciously empty tree; nothing is written to the working tree.
#
# Both modes generate all apps and report every failure (they don't stop at the
# first). Re-run after any change under src/adapter/nimbus/.
#
# Usage: scripts/examples.sh [--check]
set -euo pipefail

cd "$(dirname "$0")/.."

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

export ESDM_BIN="${ESDM_BIN:-$PWD/tools/esdm}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

shopt -s nullglob
apps=(examples/*/)
if [ ${#apps[@]} -eq 0 ]; then
    echo "No example apps found under examples/ — nothing to generate." >&2
    exit 1
fi

fail=0
for app_dir in "${apps[@]}"; do
    [ -f "${app_dir}esdmgen.yaml" ] || continue
    app="$(basename "$app_dir")"

    # Every app is generated with both targets: the one its esdmgen.yaml names
    # (nimbus-eventsourcingdb → generated/nimbus) and nimbus-postgres.
    for target in default nimbus-postgres; do
        if [ "$target" = "default" ]; then
            target_args=()
            slug="nimbus"
            label="$app"
        else
            target_args=(--target "$target")
            slug="$target"
            label="$app ($target)"
        fi

        if [ "$CHECK" -eq 1 ]; then
            gen_out="$WORK/$app/$slug"
            deno_args=(-o "$WORK/$app")
        else
            gen_out="${app_dir}generated/$slug"
            deno_args=()   # esdmgen.yaml's `out: generated` → examples/<app>/generated/<slug>
        fi

        if ! deno run --allow-read --allow-write --allow-env --allow-run src/main.ts \
            generate "$app_dir" "${deno_args[@]}" "${target_args[@]}" >/dev/null; then
            echo "$label: GENERATION FAILED"
            fail=1
            continue
        fi

        count="$(find "$gen_out" -type f 2>/dev/null | wc -l)"
        if [ "$count" -lt 10 ]; then
            echo "$label: SUSPICIOUSLY EMPTY ($count files)"
            fail=1
            continue
        fi
        echo "$label: $count files"

        # Quality bar: if the app emits tests (it has a feature file), RUN them so
        # an emitter- or model-regression fails HERE rather than shipping silently
        # broken golden tests. Generated code carries intentional type looseness,
        # so run with --no-check.
        if [ -d "$gen_out/tests" ]; then
            if (cd "$gen_out" && deno test --no-check -A tests/ >/dev/null 2>&1); then
                echo "$label: emitted tests PASS"
            else
                echo "$label: EMITTED TESTS FAILED"
                fail=1
            fi
        fi
    done
done

exit $fail
