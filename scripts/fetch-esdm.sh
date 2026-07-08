#!/usr/bin/env bash
# Downloads the pinned upstream `esdm` CLI into tools/esdm (gitignored) so the
# lint gate works on a fresh clone with no manual install. The binary is the
# full esdm CLI (`lint` is one of its subcommands); this repo pins the version
# it was built against and verifies the download against an embedded SHA-256.
# Preferred over committing the ~9.5 MB, single-platform binary into git.
#
# Usage:
#   scripts/fetch-esdm.sh                       # fetch into tools/esdm for this OS/arch
#   scripts/fetch-esdm.sh --force               # re-download even if already present
#   ESDM_VERSION=0.13.0 scripts/fetch-esdm.sh   # override the pinned version (no embedded
#                                               #   checksum → needs ESDM_SKIP_VERIFY=1)
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${ESDM_VERSION:-0.12.0}"
VERSION="${VERSION#v}"
BASE_URL="https://esdm.s3.fr-par.scw.cloud"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# --- resolve platform -------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN*) os=windows ;;
    *)
        echo "fetch-esdm: unsupported OS '$os' — install esdm manually" >&2
        echo "  https://www.esdm.io/getting-started/installing-esdm/" >&2
        exit 1
        ;;
esac
case "$arch" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *)
        echo "fetch-esdm: unsupported architecture '$arch'" >&2
        exit 1
        ;;
esac

asset="esdm-${os}-${arch}"
dest="tools/esdm"
if [ "$os" = windows ]; then
    asset="${asset}.exe"
    dest="tools/esdm.exe"
fi

# --- expected checksum (pinned version only) --------------------------------
sha=""
if [ "$VERSION" = "0.12.0" ]; then
    case "$asset" in
        esdm-linux-amd64) sha=635d10c78bb1f1413d65a8a96f0d11e90e8de26e36b8301ff69f101ca8853768 ;;
        esdm-linux-arm64) sha=2fd3477151aa78d83b65ae83dea6732ea9aa7b4b40d203d096dc264dab3318eb ;;
        esdm-darwin-amd64) sha=806291ad11b71ebc7f29ce1036d4389828446c2fea28cc0d11843d0df9f5daa5 ;;
        esdm-darwin-arm64) sha=68ab6e3ccc130f99cc01bc61b22bf8d4facf274fc5521f672c5cc720a3f8db5a ;;
        esdm-windows-amd64.exe) sha=b598d766e87a6d5b098123c6394ae2af1ccb11220ba311417f343cc69b645019 ;;
        esdm-windows-arm64.exe) sha=a0a8356f2bf289feccc44b6c789caf70e4cdbece0c1576f2af449f1adf47ac28 ;;
    esac
fi

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        echo "fetch-esdm: need sha256sum or shasum to verify the download" >&2
        exit 1
    fi
}

# --- already present & verified? -------------------------------------------
if [ "$FORCE" -eq 0 ] && [ -x "$dest" ] && [ -n "$sha" ] && [ "$(sha256_of "$dest")" = "$sha" ]; then
    echo "fetch-esdm: $dest already up to date (esdm v$VERSION $os/$arch)"
    exit 0
fi

# --- refuse an unpinned version unless told otherwise -----------------------
if [ -z "$sha" ] && [ "${ESDM_SKIP_VERIFY:-0}" != 1 ]; then
    echo "fetch-esdm: no embedded checksum for esdm v$VERSION/$asset." >&2
    echo "  Use the pinned version (0.12.0), or set ESDM_SKIP_VERIFY=1 to fetch unverified." >&2
    exit 1
fi

# --- download, verify, install ---------------------------------------------
url="$BASE_URL/$VERSION/$asset"
mkdir -p tools
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "fetch-esdm: downloading $url"
if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$tmp"
else
    echo "fetch-esdm: need curl or wget to download" >&2
    exit 1
fi

if [ -n "$sha" ]; then
    got="$(sha256_of "$tmp")"
    if [ "$got" != "$sha" ]; then
        echo "fetch-esdm: checksum mismatch for $asset" >&2
        echo "  expected $sha" >&2
        echo "  got      $got" >&2
        exit 1
    fi
else
    echo "fetch-esdm: WARNING — downloaded unverified (ESDM_SKIP_VERIFY=1)" >&2
fi

chmod +x "$tmp"
mv "$tmp" "$dest"
trap - EXIT

echo "fetch-esdm: installed esdm v$VERSION ($os/$arch) → $dest"
"$dest" version 2>/dev/null | head -1 || true
if [ "$os" = windows ]; then
    echo "fetch-esdm: the lint auto-resolver looks for tools/esdm — set ESDM_BIN=$PWD/$dest"
fi
