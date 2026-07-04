// Test 2: spawn a Worker via `new URL("worker.ts", import.meta.url)`
// where THIS file is loaded via a symlink. Mimics ente's situation.

import { writeFileSync, unlinkSync, symlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

// We need the spawner file ITSELF to be loaded via a symlink, so its
// import.meta.url reflects whichever path Bun considers canonical.
// Build a small staging:
//
//   /tmp/worker-test/real/spawn.ts        — real spawner
//   /tmp/worker-test/real/worker.ts       — real worker
//   /tmp/worker-test/linked/spawn.ts      — symlink to ../real/spawn.ts
//
// Then `bun run /tmp/worker-test/linked/spawn.ts` mirrors ente's setup:
// linked file imports adjacent "worker.ts" via import.meta.url.

const stage = "/tmp/coralstack-worker-test";
const real = join(stage, "real");
const linked = join(stage, "linked");
if (!existsSync(real)) mkdirSync(real, { recursive: true });
if (!existsSync(linked)) mkdirSync(linked, { recursive: true });

const realSpawn = join(real, "spawn.ts");
const realWorker = join(real, "worker.ts");
const linkedSpawn = join(linked, "spawn.ts");

writeFileSync(
    realWorker,
    `
self.onmessage = (e) => {
    self.postMessage({ ok: true, echo: e.data });
};
`,
);

writeFileSync(
    realSpawn,
    `
const t0 = Date.now();
const log = (msg) => console.log(\`+\${Date.now() - t0}ms (spawn) \${msg}\`);
log("import.meta.url=" + import.meta.url);
log("constructing Worker via new URL('worker.ts', import.meta.url)");
const url = new URL("worker.ts", import.meta.url);
log("resolved URL: " + url.toString());
const w = new Worker(url);
w.onmessage = (e) => {
    log("got reply: " + JSON.stringify(e.data));
    w.terminate();
    process.exit(0);
};
w.onerror = (e) => {
    log("worker error: " + e);
    process.exit(2);
};
w.postMessage({ ping: 1 });
setTimeout(() => { log("TIMEOUT"); process.exit(1); }, 3000);
`,
);

// (Re-)symlink the spawner.
try { unlinkSync(linkedSpawn); } catch {}
symlinkSync(realSpawn, linkedSpawn);

log(`staged. running symlinked spawner: ${linkedSpawn}`);

const child = Bun.spawn({
    cmd: ["bun", "run", linkedSpawn],
    stdout: "inherit",
    stderr: "inherit",
});
const exitCode = await child.exited;
log(`child exited ${exitCode}`);
