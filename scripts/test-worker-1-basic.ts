// Test 1: bare Worker with postMessage echo. No comlink, no symlinks.
// Establishes whether Bun's Worker itself works at all.

import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

// Write a worker file next to this script.
const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, "_test-worker-1-child.ts");
writeFileSync(
    workerPath,
    `
self.onmessage = (e) => {
    console.error("[child] received:", e.data);
    self.postMessage({ echo: e.data, pid: process.pid });
};
console.error("[child] worker started");
`,
);

log("constructing Worker");
const worker = new Worker(new URL(workerPath, import.meta.url));
log("Worker constructed");

worker.onmessage = (e) => {
    log(`[parent] received: ${JSON.stringify(e.data)}`);
    worker.terminate();
    unlinkSync(workerPath);
    log("done");
};
worker.onerror = (e) => {
    log(`[parent] error: ${e}`);
    unlinkSync(workerPath);
};

log("posting message");
worker.postMessage({ hello: "from main" });

// Safety net
setTimeout(() => {
    log("TIMEOUT — Worker never responded");
    worker.terminate();
    try { unlinkSync(workerPath); } catch {}
    process.exit(1);
}, 5000);
