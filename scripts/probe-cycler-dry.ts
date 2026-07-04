// probe-cycler-dry.ts — exercises HelperCycler without needing museum
// credentials. Validates spawn → ping → forced rotate → ping survives,
// plus an auth.restore round-trip with a synthetic (invalid) bundle to
// confirm the RPC is wired and surfaces hydrate errors as RPC errors
// rather than crashing the helper.
//
// What this DOES NOT cover:
//   - real auth.restore success (would need a real session bundle)
//   - upload.put_file rotation accounting (the rotateAfter* counters are
//     only advanced by putFile; here we use rotate() directly)
//
// For the full end-to-end test, see scripts/probe-cycler.ts (needs
// ENTE_EMAIL / ENTE_PASSWORD).

import { HelperCycler } from "../src/worker-pool.ts";

const helperRoot = `${process.env.HOME}/Dev/personal/coralstack-ente-helper`;
const useBinary = process.env.HELPER_MODE !== "bun";

const cycler = new HelperCycler({
    command: useBinary ? `${helperRoot}/dist/ente-helper` : "bun",
    args: useBinary ? [] : ["--preserve-symlinks", "run", "src/index.ts"],
    cwd: helperRoot,
    // Limits don't matter for this probe — we call rotate() directly.
    rotateAfterFiles: 1_000_000,
    rotateAfterBytes: Number.MAX_SAFE_INTEGER,
    rotateAfterMillis: 60 * 60_000,
    onEvent: (e) => console.error("event:", JSON.stringify(e)),
});

console.error(`helper: ${useBinary ? "compiled binary" : "bun run"}`);

let exitCode = 0;
try {
    console.error("→ start");
    await cycler.start();

    console.error("→ ping (initial)");
    const p1 = (await cycler.call("ping", undefined)) as string;
    if (p1 !== "pong") throw new Error(`ping returned ${JSON.stringify(p1)}`);

    console.error("→ auth.restore with invalid bundle (expect RPC error)");
    try {
        await cycler.call("auth.restore", { id: 1, email: "x" });
        throw new Error(
            "auth.restore should have rejected the partial bundle",
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("auth.restore")) {
            throw new Error(
                `unexpected error shape from invalid bundle: ${msg}`,
            );
        }
        console.error(`  rejected as expected: ${msg.slice(0, 80)}...`);
    }

    console.error("→ ping after invalid restore (helper should still be alive)");
    const p2 = (await cycler.call("ping", undefined)) as string;
    if (p2 !== "pong") throw new Error(`post-error ping returned ${p2}`);

    console.error("→ force rotate()");
    const beforeRotate = cycler.stats();
    await cycler.rotate();
    const afterRotate = cycler.stats();
    if (afterRotate.rotations !== beforeRotate.rotations + 1) {
        throw new Error(
            `rotations did not advance: ${beforeRotate.rotations} → ${afterRotate.rotations}`,
        );
    }

    console.error("→ ping (post-rotation, fresh helper)");
    const p3 = (await cycler.call("ping", undefined)) as string;
    if (p3 !== "pong") throw new Error(`post-rotate ping returned ${p3}`);

    console.error("→ collections.restore with invalid params (expect RPC error)");
    try {
        await cycler.call("collections.restore", {});
        throw new Error("collections.restore should have rejected empty params");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("collections.restore")) {
            throw new Error(`unexpected error shape: ${msg}`);
        }
        console.error(`  rejected as expected: ${msg.slice(0, 80)}...`);
    }

    console.error("→ rotate again, ping again");
    await cycler.rotate();
    const p4 = (await cycler.call("ping", undefined)) as string;
    if (p4 !== "pong") throw new Error(`second-rotate ping returned ${p4}`);

    const final = cycler.stats();
    console.error("final stats:", JSON.stringify(final));
    if (final.rotations !== 2) {
        throw new Error(`expected 2 rotations, got ${final.rotations}`);
    }
    console.error("OK");
} catch (err) {
    exitCode = 1;
    console.error(
        "FAIL:",
        err instanceof Error ? err.stack ?? err.message : String(err),
    );
} finally {
    await cycler.stop();
}
process.exit(exitCode);
