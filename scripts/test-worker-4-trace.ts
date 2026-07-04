// Test 4: trace exactly what happens when Bun loads ente's crypto worker.
// We wrap the worker file in a temp copy with a console.error at the top
// (before any imports) and another after the imports, to see where it
// gets stuck (if it gets stuck).

import { writeFileSync, unlinkSync, readFileSync } from "node:fs";

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

const enteWorker =
    "/Users/dustindoan/Dev/personal/coralstack-ente-helper/node_modules/ente-base/crypto/worker.ts";

// Read and instrument
const original = readFileSync(enteWorker, "utf-8");
const instrumented = `
// @ts-nocheck
console.error("[worker] starting; before imports");
` + original.replace(
    "expose(CryptoWorker);",
    `
console.error("[worker] imports complete; about to expose");
expose(CryptoWorker);
console.error("[worker] expose() returned");
`,
);

const tracedWorker = enteWorker.replace("worker.ts", "_worker-traced.ts");
writeFileSync(tracedWorker, instrumented);
log(`wrote traced worker → ${tracedWorker}`);

const w = new Worker(new URL(`file://${tracedWorker}`));
w.onmessage = (e) => log(`[parent] got message: ${JSON.stringify(e.data)}`);
w.onerror = (e) => {
    const err = e as ErrorEvent;
    log(`[parent] error: ${err.message} (${err.filename}:${err.lineno})`);
};
log("Worker constructed; waiting 3s for trace lines on stderr");

setTimeout(() => {
    log("timeout — terminating");
    try { unlinkSync(tracedWorker); } catch {}
    w.terminate();
    process.exit(0);
}, 3000);
