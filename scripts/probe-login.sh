#!/usr/bin/env bash
#
# Probe a real login against the museum without putting creds in shell
# history. Reads ENTE_EMAIL + ENTE_PASSWORD from the environment.
#
# Usage:
#   read -rs ENTE_PASSWORD     # prompts silently, no terminal echo
#   export ENTE_EMAIL=you@example.com ENTE_PASSWORD
#   bash scripts/probe-login.sh
#
# Or one-shot (your password WILL be in `ps`/history briefly):
#   ENTE_EMAIL=you@example.com ENTE_PASSWORD='...' bash scripts/probe-login.sh

set -euo pipefail

if [[ -z "${ENTE_EMAIL:-}" || -z "${ENTE_PASSWORD:-}" ]]; then
    echo "Set ENTE_EMAIL and ENTE_PASSWORD env vars first." >&2
    echo "Recommended: use 'read -rs ENTE_PASSWORD; export ENTE_PASSWORD'" >&2
    exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Build the JSON-RPC request via jq if available, otherwise printf-with-
# python-style escaping. jq handles quoting safely.
if command -v jq >/dev/null 2>&1; then
    payload=$(jq -nc \
        --arg email "$ENTE_EMAIL" \
        --arg pw "$ENTE_PASSWORD" \
        '{jsonrpc:"2.0", id:1, method:"auth.login", params:{email:$email, password:$pw}}')
else
    # Fallback: best-effort JSON via printf. Password with " or \ will break.
    payload=$(printf '{"jsonrpc":"2.0","id":1,"method":"auth.login","params":{"email":"%s","password":"%s"}}' \
        "$ENTE_EMAIL" "$ENTE_PASSWORD")
fi

cd "$HERE"
echo "$payload" | bun --preserve-symlinks run src/index.ts
