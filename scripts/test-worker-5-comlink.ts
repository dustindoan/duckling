// Test 5: use comlink to call a real method on ente's worker.
// Worker LOADS fine (test 4 proved that). Question: does comlink's
// message protocol round-trip work in Bun?

import { wrap, type Remote } from "comlink";
import type { CryptoWorker } from "../node_modules/ente-base/crypto/worker";

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

const workerPath =
    "/Users/dustindoan/Dev/personal/coralstack-ente-helper/node_modules/ente-base/crypto/worker.ts";

log("constructing Worker");
const w = new Worker(new URL(`file://${workerPath}`));

log("wrapping with comlink");
const remote = wrap<typeof CryptoWorker>(w) as unknown as Remote<CryptoWorker>;

log("calling remote.toB64(Uint8Array([72,105]))");
try {
    const result = await Promise.race([
        remote.toB64(new Uint8Array([72, 105])),
        new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("3s timeout")), 3000),
        ),
    ]);
    log(`success: ${result}`);
    w.terminate();
    process.exit(0);
} catch (e) {
    log(`error: ${(e as Error).message}`);
    w.terminate();
    process.exit(1);
}
