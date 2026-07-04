// smoke.ts — upstream-drift canary.
//
// Run after every `git pull` in ~/Dev/personal/ente/. The point is to catch
// regressions from upstream ente changes BEFORE they reach a user's hand:
// if this script breaks, we find out at sync time, not at runtime during a
// real migration.
//
// Deliberately minimal — login + create collection + one upload + whoami.
// Each step is one specific failure mode of "did the sibling-workspace
// strategy still resolve cleanly":
//
//   login      → SRP + 3-layer token decrypt + ente session hydrate
//   create     → ente's createAlbum + collection key encryption
//   upload     → upload-service + crypto + thumbnail + multipart PUT
//   delete     → DELETE /collections/v3/{id} album
//   whoami     → museum reachability + auth token still valid
//
// Rotation correctness lives in probe-cycler.ts; this script doesn't try
// to exercise auth.restore / collections.restore. If a rotation bug
// regresses, that's a probe-cycler.ts failure, not a smoke failure.
//
// Exits 0 on full success, 1 on any step failure with a one-line summary
// of which step broke. Designed to drop into a CI loop or a shell alias.
//
// Reads ENTE_EMAIL + ENTE_PASSWORD. HELPER_MODE=binary uses dist/duckling;
// default uses `bun --preserve-symlinks run src/index.ts` for iteration.

import { existsSync, statSync } from "node:fs";
import sharp from "sharp";
import { HelperCycler } from "../src/worker-pool.ts";

const email = process.env.ENTE_EMAIL;
const password = process.env.ENTE_PASSWORD;
if (!email || !password) {
    console.error("smoke: set ENTE_EMAIL and ENTE_PASSWORD first");
    process.exit(1);
}

const helperRoot = new URL("..", import.meta.url).pathname;
const useBinary = process.env.HELPER_MODE === "binary";

const testImage = "/tmp/coralstack-smoke.jpg";
if (!existsSync(testImage)) {
    // One-time generation. Tiny — the point is to exercise the pipeline,
    // not to actually stress upload throughput.
    await sharp({
        create: {
            width: 160,
            height: 160,
            channels: 3,
            background: { r: 80, g: 200, b: 140 },
        },
    })
        .jpeg({ quality: 85 })
        .toFile(testImage);
}

const cycler = new HelperCycler({
    command: useBinary ? `${helperRoot}dist/duckling` : "bun",
    args: useBinary ? [] : ["--preserve-symlinks", "run", "src/index.ts"],
    cwd: helperRoot,
    // Disable rotation triggers — smoke is one upload, no rotation needed.
    rotateAfterFiles: Number.MAX_SAFE_INTEGER,
    rotateAfterBytes: Number.MAX_SAFE_INTEGER,
    rotateAfterMillis: Number.MAX_SAFE_INTEGER,
});

const t0 = Date.now();
let step = "(none)";
let exitCode = 0;
try {
    step = "login";
    await cycler.login(email, password);

    step = "create-collection";
    const album = await cycler.createCollection(`smoke-${Date.now()}`);

    step = "upload";
    const size = statSync(testImage).size;
    const result = (await cycler.putFile(testImage, album.id, size)) as {
        type?: string;
    };
    if (result.type !== "uploaded") {
        throw new Error(
            `upload returned unexpected type=${result.type} (expected 'uploaded'). ` +
                `Full result: ${JSON.stringify(result)}`,
        );
    }

    // Dedup-drift canary. Our retry dedup (upload.ts) computes a content
    // hash via ente's exported chunkHash* worker primitives and compares
    // it against stored files via ente's exported metadataHash. Two things
    // are NOT reused because ente doesn't export them: the orchestration of
    // computeHash (we feed the whole buffer in one update; ente chunks it —
    // equal only because crypto_generichash is byte-streaming) and the
    // live-photo `${imageHash}:${videoHash}` join. If upstream ente changes
    // either — or the hash algorithm/encoding behind chunkHash* in a way we
    // don't follow — our computed hash silently stops matching the stored
    // hash and re-exports duplicate instead of deduping.
    //
    // This step exercises that exact path end-to-end: re-upload the SAME
    // bytes under a Finder-collision name (` (1)` suffix), which trips the
    // hash-only pre-check. It MUST resolve `alreadyUploaded`. If it returns
    // `uploaded`, the hash logic has drifted from ente's — fail loudly here,
    // at git-pull time, not during a user's real export.
    step = "dedup-drift";
    const dedupResult = (await cycler.call("upload.put_file", {
        path: testImage,
        collectionID: album.id,
        fileName: "coralstack-smoke (1).jpg",
    })) as { type?: string };
    if (dedupResult.type !== "alreadyUploaded") {
        throw new Error(
            `retry dedup returned type=${dedupResult.type} (expected ` +
                `'alreadyUploaded'). Our content-hash pre-check no longer ` +
                `matches ente's stored hash — upstream ente likely changed ` +
                `computeHash orchestration, the live-photo hash format, or ` +
                `the chunkHash* primitives. See computeContentHash in ` +
                `src/rpc/methods/upload.ts. Full result: ` +
                JSON.stringify(dedupResult),
        );
    }

    step = "delete";
    const deleteResult = (await cycler.call("collections.delete", {
        id: album.id,
    })) as { ok?: boolean };
    if (deleteResult.ok !== true) {
        throw new Error(
            `collections.delete returned unexpected result: ${JSON.stringify(deleteResult)}`,
        );
    }

    step = "whoami";
    const who = (await cycler.call("auth.whoami", undefined)) as {
        email?: string;
        fileCount?: number;
    };
    if (who.email !== email) {
        throw new Error(
            `whoami returned email=${who.email}, expected ${email}`,
        );
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(
        `smoke: OK (${elapsed}s) — collection ${album.id}, ` +
            `fileCount now ${who.fileCount}`,
    );
} catch (err) {
    exitCode = 1;
    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`smoke: FAIL at step '${step}' (${elapsed}s) — ${msg}`);
    if (err instanceof Error && err.stack) {
        console.error(err.stack);
    }
} finally {
    await cycler.stop();
}
process.exit(exitCode);
