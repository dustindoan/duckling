// Worker-bypass shim for `ente-base/crypto/index.ts`.
//
// Upstream's index.ts is a dispatcher: every function checks `inWorker()`
// and either calls libsodium directly (when already in a worker) or
// delegates to a shared Web Worker (when on the main thread). The Worker
// indirection is purely a UI-responsiveness move; it has no security or
// correctness role.
//
// In our headless Bun helper there's no UI to keep responsive, and Web
// Worker construction via `new URL("worker.ts", import.meta.url)` doesn't
// resolve cleanly through our symlinked tree. So we replace the index
// with a thin re-export of libsodium and skip the worker layer entirely.
//
// This file gets dropped into `node_modules/ente-base/crypto/index.ts`
// via scripts/link-ente.sh. The relative `./libsodium` import resolves to
// a sibling in that directory (a symlink to ente's real libsodium.ts).
//
// Audit alignment: the original audit said "CryptoWorker is a thin
// facade — every method delegates verbatim to libsodium.ts. Bypass is
// simpler." This shim is that bypass.

// Use bare package imports (not relative `./libsodium`). Bun resolves
// relative imports from the file's REAL path on disk (i.e. our src/
// tree), not its symlink mount in node_modules. Bare package imports go
// through node_modules walk-up, which lands correctly regardless.
import * as libsodium from "ente-base/crypto/libsodium";

// Tracer — exists only to prove the shim is loaded. If you see this log
// once at startup, ente's imports of `ente-base/crypto` are landing
// here. If you don't see it, Bun is resolving past the symlink to
// ente's real index.ts and using the worker dispatcher.
console.error("[shim] crypto-index loaded — worker bypass active");

export * from "ente-base/crypto/libsodium";

export type {
    BytesOrB64,
    DerivedKey,
    EncryptedBlob,
    EncryptedBlobB64,
    EncryptedBlobBytes,
    EncryptedBox,
    EncryptedBoxB64,
    EncryptedFile,
    InitChunkDecryptionResult,
    InitChunkEncryptionResult,
    KeyPair,
    SodiumStateAddress,
} from "ente-base/crypto/types";

// createComlinkCryptoWorker: some consumers (notably the upload code)
// construct their OWN crypto worker pool for parallelism. Returning a
// fake "worker" whose `.remote` resolves to libsodium directly satisfies
// the call-site interface while keeping everything inline.
//
// libsodium's exported function names match CryptoWorker's method names
// (worker.ts is a one-to-one facade), so consumers calling
// `(await comlinkWorker.remote).encryptBlob(...)` get the right thing.
export const createComlinkCryptoWorker = () => ({
    remote: Promise.resolve(libsodium),
    worker: { terminate: () => {} } as unknown as Worker,
    terminate: () => {},
});
