// probe-cycler.ts — exercises HelperCycler with rotateAfterFiles=2.
//
// Uploads 5 distinct test images to one collection through a single
// HelperCycler instance. Expected behavior:
//
//   file 1: spawn helper, login, create collection, upload          (rot 0)
//   file 2: upload                                                   (rot 0)
//   file 3: rotate (kill+spawn+auth.restore+collections.restore),
//           then upload                                              (rot 1)
//   file 4: upload                                                   (rot 1)
//   file 5: rotate, then upload                                      (rot 2)
//
// Pass criteria: all 5 uploads return non-error, stats.rotations === 2,
// and a fresh auth.whoami after the last rotation still succeeds.
//
// Reads ENTE_EMAIL + ENTE_PASSWORD from env. Set HELPER_MODE=binary to
// drive the compiled helper; otherwise uses `bun --preserve-symlinks
// run src/index.ts` for iteration speed.

import { existsSync, statSync } from "node:fs";
import sharp from "sharp";
import { HelperCycler } from "../src/worker-pool.ts";

const email = process.env.ENTE_EMAIL;
const password = process.env.ENTE_PASSWORD;
if (!email || !password) {
    console.error("Set ENTE_EMAIL and ENTE_PASSWORD env vars first.");
    process.exit(1);
}

const helperRoot = `${process.env.HOME}/Dev/personal/coralstack-ente-helper`;
const useBinary = process.env.HELPER_MODE === "binary";

// Generate 5 visually-distinct test JPEGs so we can confirm each one
// landed (not just dedup'd against the previous).
const testImages: string[] = [];
for (let i = 0; i < 5; i++) {
    const path = `/tmp/coralstack-cycler-test-${i}.jpg`;
    if (!existsSync(path)) {
        await sharp({
            create: {
                width: 240,
                height: 240,
                channels: 3,
                background: {
                    r: (40 + i * 35) % 256,
                    g: (200 - i * 20) % 256,
                    b: (90 + i * 25) % 256,
                },
            },
        })
            .jpeg({ quality: 88 })
            .toFile(path);
    }
    testImages.push(path);
}

const cycler = new HelperCycler({
    command: useBinary ? `${helperRoot}/dist/ente-helper` : "bun",
    args: useBinary
        ? []
        : ["--preserve-symlinks", "run", "src/index.ts"],
    cwd: helperRoot,
    rotateAfterFiles: 2,
    // Set the other limits very high so only file-count triggers in this
    // test; we want the rotation count to be deterministic.
    rotateAfterBytes: 10 * 1024 * 1024 * 1024,
    rotateAfterMillis: 60 * 60_000,
    onEvent: (e) => console.error("event:", JSON.stringify(e)),
});

console.error(`helper: ${useBinary ? "compiled binary" : "bun run"}`);

try {
    console.error("→ login");
    await cycler.login(email, password);

    const albumName = `cycler-test-${Date.now()}`;
    console.error(`→ create collection "${albumName}"`);
    const album = await cycler.createCollection(albumName);
    console.error(`  collection ${album.id}`);

    for (let i = 0; i < testImages.length; i++) {
        const path = testImages[i]!;
        const size = statSync(path).size;
        const before = cycler.stats();
        const result = (await cycler.putFile(path, album.id, size)) as {
            type?: string;
            file?: { id?: number };
        };
        const after = cycler.stats();
        const rotated = after.rotations > before.rotations;
        // UploadResult is { type: "uploaded"; file: EnteFile }, not uploadedFile.
        const fileID =
            result.type === "uploaded" ||
            result.type === "uploadedWithStaticThumbnail"
                ? (result as { file?: { id?: number } }).file?.id
                : undefined;
        console.error(
            `  file ${i + 1}/${testImages.length}: rotations=${after.rotations}${
                rotated ? " (rotated before this upload)" : ""
            } type=${result.type} fileID=${fileID}`,
        );
    }

    // After the last rotation, confirm the rehydrated helper can still
    // talk to the museum with the restored token.
    console.error("→ auth.whoami (post-rotation sanity)");
    const who = (await cycler.call("auth.whoami", undefined)) as {
        email?: string;
        fileCount?: number;
    };
    console.error(`  whoami: ${who.email} (fileCount=${who.fileCount})`);

    const final = cycler.stats();
    console.error("final stats:", JSON.stringify(final));

    // Hard assertion so CI / smoke fails loudly if rotation didn't fire.
    if (final.rotations !== 2) {
        throw new Error(
            `expected 2 rotations with rotateAfterFiles=2 and 5 uploads, ` +
                `got ${final.rotations}`,
        );
    }
    if (final.totalFiles !== 5) {
        throw new Error(
            `expected 5 totalFiles, got ${final.totalFiles}`,
        );
    }
    console.error("OK");
} finally {
    await cycler.stop();
}
