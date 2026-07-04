// Test 9: TWO sequential calls through comlink on the same worker.
// If the second call hangs, that's a Bun-vs-comlink regression of
// Bun#3669 (claimed fixed 2023-08, may have regressed).

import { wrap, type Remote } from "comlink";
import type { CryptoWorker } from "../node_modules/ente-base/crypto/worker";

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

const workerPath =
    "/Users/dustindoan/Dev/personal/coralstack-ente-helper/node_modules/ente-base/crypto/worker.ts";

const worker = new Worker(new URL(`file://${workerPath}`));
const RemoteClass = wrap<typeof CryptoWorker>(worker);
const instance = (await new RemoteClass()) as Remote<CryptoWorker>;
log("instance ready");

log("CALL 1: toB64");
try {
    const r1 = await Promise.race([
        instance.toB64(new Uint8Array([72, 105])),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("call1 timeout")), 3000)),
    ]);
    log(`call 1 returned: ${r1}`);
} catch (e) {
    log(`call 1 failed: ${(e as Error).message}`);
    process.exit(1);
}

log("CALL 2: toB64 again, same args");
try {
    const r2 = await Promise.race([
        instance.toB64(new Uint8Array([72, 105])),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("call2 timeout")), 3000)),
    ]);
    log(`call 2 returned: ${r2}`);
} catch (e) {
    log(`call 2 failed: ${(e as Error).message}`);
    process.exit(1);
}

log("done");
worker.terminate();
process.exit(0);
