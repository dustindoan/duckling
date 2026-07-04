// Test 3: spawn ente's actual crypto worker file. This is what was
// hanging us. Now we want to see EXACTLY where it stops.

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

const enteWorkerPath =
    "/Users/dustindoan/Dev/personal/ente/web/packages/base/crypto/worker.ts";

log(`constructing Worker for ${enteWorkerPath}`);
const url = new URL(`file://${enteWorkerPath}`);
const worker = new Worker(url);

worker.onmessage = (e) => {
    log("got message from ente worker: " + JSON.stringify(e.data));
};
worker.onerror = (e) => {
    log("ente worker error event");
    const err = e as ErrorEvent;
    log(`  message: ${err.message}`);
    log(`  filename: ${err.filename}`);
    log(`  lineno: ${err.lineno}`);
    process.exit(2);
};

log("Worker constructed (or at least did not throw)");

// Try sending a comlink-style probe message
log("posting probe message");
worker.postMessage({ probe: true });

setTimeout(() => {
    log("TIMEOUT 3s — no reply, no error");
    worker.terminate();
    process.exit(1);
}, 3000);
