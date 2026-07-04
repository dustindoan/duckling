#!/usr/bin/env bash
#
# Probe login + create a fresh "helper-test" collection in the same helper
# process. Two ndjson requests on stdin; helper holds in-memory session
# state between them.
#
# Same auth env-var contract as probe-login.sh.

set -euo pipefail

if [[ -z "${ENTE_EMAIL:-}" || -z "${ENTE_PASSWORD:-}" ]]; then
    echo "Set ENTE_EMAIL and ENTE_PASSWORD env vars first." >&2
    exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

login=$(jq -nc \
    --arg email "$ENTE_EMAIL" \
    --arg pw "$ENTE_PASSWORD" \
    '{jsonrpc:"2.0", id:1, method:"auth.login", params:{email:$email, password:$pw}}')
create=$(jq -nc \
    --arg name "helper-test" \
    '{jsonrpc:"2.0", id:2, method:"collections.create", params:{name:$name}}')

cd "$HERE"
printf '%s\n%s\n' "$login" "$create" | bun --preserve-symlinks run src/index.ts
