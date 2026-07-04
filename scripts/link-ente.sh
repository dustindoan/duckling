#!/usr/bin/env bash
#
# link-ente.sh — set up node_modules so the sibling ente checkout is
# resolvable as if it were installed via npm.
#
# Two flavors:
#
#   1. Whole-tree SYMLINK for packages we consume as-is:
#         node_modules/ente-gallery → ~/Dev/personal/ente/web/packages/gallery
#      Used for packages where we don't override any file. Internal
#      relative imports work because they resolve within the symlink
#      target's tree (which is unchanged).
#
#   2. Real-copy COPY for ente-base, because we need to override
#      base/crypto/index.ts and ente's relative imports (e.g.
#      session.ts: `from "./crypto"`) resolve through real paths.
#      Bun's --preserve-symlinks does not stop this; the file's real
#      location wins. So we copy.
#         node_modules/ente-base/             (real dir, real files)
#         node_modules/ente-base/crypto/index.ts (our shim — overrides ente's)
#
#   3. Reverse-link: ente/web/node_modules → our node_modules. Required
#      so bun's bundler walk-up finds our npm deps from inside ente's
#      tree.
#
# Run as a postinstall hook from package.json. Idempotent.
#
# After upstream ente changes, re-run `bun run link-ente` to re-copy.
# An ente-pull in ~/Dev/personal/ente/ is silent until you re-run.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTE_ROOT="${ENTE_ROOT:-$HOME/Dev/personal/ente/web/packages}"

if [[ ! -d "$ENTE_ROOT" ]]; then
    echo "link-ente: ente checkout not found at $ENTE_ROOT" >&2
    echo "  Set ENTE_ROOT env var or clone https://github.com/ente-io/ente.git" >&2
    exit 1
fi

mkdir -p "$HERE/node_modules"

# --- 1. Symlinked packages.
SIMPLE_PACKAGES=(gallery accounts media utils new)

for pkg in "${SIMPLE_PACKAGES[@]}"; do
    src="$ENTE_ROOT/$pkg"
    dest="$HERE/node_modules/ente-$pkg"

    [[ -d "$src" ]] || { echo "link-ente: source missing: $src" >&2; exit 1; }

    if [[ -L "$dest" || -e "$dest" ]]; then
        rm -f "$dest" 2>/dev/null || rm -rf "$dest"
    fi

    ln -s "$src" "$dest"
    echo "  linked ente-$pkg → $src"
done

# --- 2. ente-base: real copy with crypto/index.ts override.
#
# Why the override is necessary: Bun 1.3.14 has a regression of
# Bun#3669 (claimed fixed in 0.7) — the first comlink message through
# a Worker round-trips; the second hangs indefinitely. ente's crypto
# index dispatches through Worker+comlink; one shared worker handles
# many calls. So we replace the index with a direct libsodium passthrough.
#
# Reproducer: scripts/test-worker-9-second-call.ts (23 lines).
# Audit alignment: the original audit explicitly endorsed bypassing
# the Worker as "the simpler path" because CryptoWorker is a thin
# facade.
base_src="$ENTE_ROOT/base"
base_dest="$HERE/node_modules/ente-base"
override_index="$HERE/src/platform/shims/crypto-index.ts"

[[ -f "$override_index" ]] || {
    echo "link-ente: missing override at $override_index" >&2
    exit 1
}

if [[ -L "$base_dest" || -e "$base_dest" ]]; then
    rm -f "$base_dest" 2>/dev/null || rm -rf "$base_dest"
fi

cp -R "$base_src" "$base_dest"
cp "$override_index" "$base_dest/crypto/index.ts"
echo "  copied ente-base (crypto/index.ts → $override_index)"

# --- 2b. @ffmpeg/ffmpeg empty.mjs override.
#
# The npm package ships an empty stub for Node (real exports only in
# browser). ente imports { FFFSType, FFmpeg } from it — those exports
# don't exist in the empty stub, so Bun errors at import time. We
# overwrite empty.mjs with our own stub that has those exports as
# inert placeholders. Real ffmpeg goes through PlatformAdapter.ffmpeg.
ffmpeg_empty="$HERE/node_modules/@ffmpeg/ffmpeg/dist/esm/empty.mjs"
ffmpeg_stub="$HERE/src/platform/shims/ffmpeg-stub.mjs"
if [[ -f "$ffmpeg_empty" ]]; then
    cp "$ffmpeg_stub" "$ffmpeg_empty"
    echo "  overrode @ffmpeg/ffmpeg empty.mjs → $ffmpeg_stub"
fi

# --- 3. Reverse-link for bundler walk-up.
ente_web="$(dirname "$ENTE_ROOT")"
ente_web_nm="$ente_web/node_modules"
if [[ -L "$ente_web_nm" ]]; then
    if [[ "$(readlink "$ente_web_nm")" != "$HERE/node_modules" ]]; then
        rm "$ente_web_nm"
        ln -s "$HERE/node_modules" "$ente_web_nm"
        echo "  re-linked $ente_web_nm → $HERE/node_modules"
    fi
elif [[ -e "$ente_web_nm" ]]; then
    echo "link-ente: $ente_web_nm exists as a real dir; refusing to overwrite." >&2
    echo "  Move it aside (mv $ente_web_nm ${ente_web_nm}.bak) then rerun." >&2
    exit 1
else
    ln -s "$HERE/node_modules" "$ente_web_nm"
    echo "  linked $ente_web_nm → $HERE/node_modules"
fi
