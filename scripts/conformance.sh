#!/usr/bin/env bash
# C4 conformance (this repo's targets vs the golden answers in ../esdm-extensions/conformance).
set -euo pipefail
cd "$(dirname "$0")/.."
exec deno run -A scripts/conformance.ts "$@"
