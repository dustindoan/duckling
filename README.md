# duckling

Headless [ente](https://ente.io) client. Runs ente desktop's own upload,
auth, and crypto code — compiled to a single binary. No Electron.

Works against ente's hosted service or a self-hosted museum.

> Third-party tool, not affiliated with or endorsed by ente. Early software;
> the CLI surface will change.

## Why another ente CLI

ente's existing CLIs (Go, and an in-progress Rust one) reimplement the
client protocol. The crypto is the highest-risk part of any reimplementation
— and they don't get ente's audited TypeScript crypto for free.

duckling takes the other bet: run the real thing. It consumes ente's web
workspace directly (the same code ente desktop ships inside Electron),
shims the Electron/browser surface behind a small platform adapter
(~500 LoC), and compiles the result with `bun build --compile`. Upload,
SRP login, key derivation, Live Photo assembly, thumbnailing, video
metadata — all upstream code, not a port.

Because long-running upload sessions in the upstream desktop app have known
memory growth, duckling is built to be supervised: the JSON-RPC transport
makes it trivial to cycle worker processes every N files, bounding any
JS-level leak by design.

## Install

Grab a release binary — macOS (arm64, x64) and Linux (x64, arm64) — or
build from source (below). macOS arm64 and Linux x64 are what CI runs the
test suite on; the other two are cross-compiled and should be treated as
best-effort.

ffmpeg (for video thumbnails/metadata): install system-wide, place a binary
next to the duckling executable, or set `DUCKLING_FFMPEG_PATH`.

## Use

```sh
# Point at your museum (defaults to ente's hosted API):
export DUCKLING_ENDPOINT=https://your-museum.example.org

duckling --list-methods            # what's callable
duckling call ping                 # → "pong"
duckling call version
```

Every capability is exposed as a JSON-RPC method, callable one-shot from
the shell:

```sh
duckling call auth.login '{"email":"you@example.org","password":"..."}'
duckling call collections.list
duckling call upload.put_file '{"path":"/photos/IMG_0042.HEIC","collectionID":123}'
```

Session state persists in `~/.duckling` (override: `DUCKLING_STATE_DIR`),
so `call` invocations after login are authenticated.

Friendlier verbs (`duckling login` with interactive 2FA prompts,
`duckling upload <folder>`) are next; they layer over the same methods.

### As a JSON-RPC server

Run `duckling` with no arguments and it speaks newline-delimited JSON-RPC
2.0 over stdio — requests in, responses + progress events out. This is how
programs embed it (the CoralStack macOS app runs it this way as a sidecar).

```sh
printf '{"jsonrpc":"2.0","id":1,"method":"ping"}\n' | duckling
```

## Build from source

Requirements: [bun](https://bun.sh), plus a checkout of
[ente](https://github.com/ente-io/ente) — duckling consumes ente's web
packages in place rather than vendoring them.

```sh
git clone https://github.com/ente-io/ente ~/Dev/personal/ente
git clone <this repo> && cd duckling
ENTE_ROOT=~/Dev/personal/ente/web/packages bun install   # links ente packages
bun run typecheck
bun run build                                            # → dist/duckling
```

`bun install`'s postinstall links the ente packages into `node_modules`
(see `scripts/link-ente.sh` for the how and the two deliberate overrides).
After pulling upstream ente, re-run `bun run link-ente`, then
`bun run smoke` (needs `ENTE_EMAIL`/`ENTE_PASSWORD`) to catch drift before
it bites. CI pins upstream to a verified SHA; a weekly workflow
(`drift.yml`) runs the same gates against upstream `main` so drift shows
up as a red scheduled run rather than a surprise at the next pull.

## Testing

`bun test` runs the offline tier (CLI surface, exit codes, stdio JSON-RPC
conformance). `DUCKLING_LIVE_TESTS=1 bun test` adds the live tier against
your museum — Live Photo pairing, a download crypto round-trip
(byte-identical content back), rename/trash — using an isolated copy of
your session and a throwaway album.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `DUCKLING_ENDPOINT` | `https://api.ente.io` | Museum API endpoint |
| `DUCKLING_STATE_DIR` | `~/.duckling` | Session/token storage |
| `DUCKLING_FFMPEG_PATH` | sibling of binary, then `PATH` | ffmpeg for video metadata |

## License

AGPL-3.0 — required, not optional: duckling compiles ente's AGPL-licensed
client code into its binary. Source for both halves is public (this repo +
[ente-io/ente](https://github.com/ente-io/ente)).
