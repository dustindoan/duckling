// Test 6: comlink with the CORRECT instantiation pattern that ente
// actually uses. expose(Class) means we have to `new` the proxy first to
// get an instance, then call methods on it.

import { wrap, type Remote } from "comlink";
import type { CryptoWorker } from "../node_modules/ente-base/crypto/worker";

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

const workerPath =
    "/Users/dustindoan/Dev/personal/coralstack-ente-helper/node_modules/ente-base/crypto/worker.ts";

log("constructing Worker");
const w = new Worker(new URL(`file://${workerPath}`));

log("wrap<typeof CryptoWorker>(worker)");
const RemoteClass = wrap<typeof CryptoWorker>(w);

log("await new RemoteClass()  ← instantiate over comlink");
try {
    const instance = (await Promise.race([
        new RemoteClass(),
        new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("3s timeout on new RemoteClass()")), 3000),
        ),
    ])) as Remote<CryptoWorker>;

    log("instance created; calling instance.toB64(Uint8Array([72,105]))");
    const result = await Promise.race([
        instance.toB64(new Uint8Array([72, 105])),
        new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("3s timeout on toB64")), 3000),
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
