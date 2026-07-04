#!/usr/bin/env bash
#
# Probe a full login → create collection → upload-one-file flow.
#
# Generates a 200×200 solid-color JPEG via sharp (avoids using any PII
# image from disk). Uploads to a freshly-created "helper-test" album.
#
# Requires ENTE_EMAIL and ENTE_PASSWORD env vars.

set -euo pipefail

if [[ -z "${ENTE_EMAIL:-}" || -z "${ENTE_PASSWORD:-}" ]]; then
    echo "Set ENTE_EMAIL and ENTE_PASSWORD env vars first." >&2
    exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Generate a test JPEG.
test_image="/tmp/coralstack-upload-test.jpg"
cd "$HERE"
bun -e "
import sharp from 'sharp';
await sharp({
  create: { width: 200, height: 200, channels: 3, background: { r: 100, g: 180, b: 220 } }
}).jpeg({ quality: 90 }).toFile('$test_image');
console.error('test image at $test_image');
"

# Build requests.
login=$(jq -nc \
    --arg email "$ENTE_EMAIL" \
    --arg pw "$ENTE_PASSWORD" \
    '{jsonrpc:"2.0", id:1, method:"auth.login", params:{email:$email, password:$pw}}')
create=$(jq -nc \
    --arg name "helper-test" \
    '{jsonrpc:"2.0", id:2, method:"collections.create", params:{name:$name}}')

# upload.put_file needs the collectionID returned by collections.create.
# Since we send all requests up front, we don't yet know the ID — work
# around by running collections.create first via a sub-invocation, then
# launching the second helper for upload. (Lazy: in a real client, the
# Swift app would just sequence dynamically.)
read_response=$(printf '%s\n%s\n' "$login" "$create" | bun --preserve-symlinks run src/index.ts)
echo "$read_response"
collectionID=$(echo "$read_response" | jq -r 'select(.id != null) | .result.id // empty' | tail -1)

if [[ -z "$collectionID" || "$collectionID" == "null" ]]; then
    echo "could not extract collectionID from above output" >&2
    exit 1
fi

echo ""
echo "=== Second helper run: upload to collection $collectionID ==="

# Second helper instance: re-login + upload. (Each helper process has its
# own in-memory session, so we re-auth here.)
upload=$(jq -nc \
    --arg path "$test_image" \
    --argjson cid "$collectionID" \
    '{jsonrpc:"2.0", id:3, method:"upload.put_file", params:{path:$path, collectionID:$cid}}')

printf '%s\n%s\n' "$login" "$upload" | bun --preserve-symlinks run src/index.ts
