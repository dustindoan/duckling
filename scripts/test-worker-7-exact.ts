// Test 7: replicate ente's EXACT ComlinkWorker pattern.
//
// Difference from test 6 (which worked):
//   - Test 6: just `wrap<typeof Class>(worker)` then `await new RemoteClass()`
//   - Ente's pattern (line 45-47 of comlink-worker.ts):
//       const comlink = wrap<T>(worker);
//       this.remote = new comlink() as Promise<...>;  // ← cast on the bare Promise
//       expose(workerBridge, worker);                  // ← bidirectional!
//
// Hypothesis: the bidirectional expose+wrap on a single Worker confuses
// comlink's message dispatch in Bun.

import { wrap, expose, type Remote } from "comlink";
import type { CryptoWorker } from "../node_modules/ente-base/crypto/worker";

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

const workerPath =
    "/Users/dustindoan/Dev/personal/coralstack-ente-helper/node_modules/ente-base/crypto/worker.ts";

log("constructing Worker");
const worker = new Worker(new URL(`file://${workerPath}`));

log("wrap<T>(worker)");
const comlinkClass = wrap<typeof CryptoWorker>(worker);

log("this.remote = new comlinkClass()  ← exact ente pattern");
const remotePromise = new comlinkClass() as unknown as Promise<Remote<CryptoWorker>>;

log("expose(workerBridge, worker)  ← bidirectional, ente does this");
const workerBridge = {
    logToDisk: (s: string) => console.error("[bridge] logToDisk:", s),
};
expose(workerBridge, worker);

log("awaiting remotePromise (the instance)");
try {
    const instance = await Promise.race([
        remotePromise,
        new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("3s timeout on instance creation")), 3000),
        ),
    ]);
    log("instance ready; calling toB64");

    const result = await Promise.race([
        instance.toB64(new Uint8Array([72, 105])),
        new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("3s timeout on toB64")), 3000),
        ),
    ]);
    log(`result: ${result}`);
    worker.terminate();
    process.exit(0);
} catch (e) {
    log(`error: ${(e as Error).message}`);
    worker.terminate();
    process.exit(1);
}
