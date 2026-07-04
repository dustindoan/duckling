// BunThumbnailer — sips-backed implementation of Thumbnailer.
//
// Replaces electron.generateImageThumbnail. Uses macOS's built-in `sips`
// command instead of sharp because:
//   - sharp has native bindings (libvips) that can't be bundled by
//     `bun build --compile`. The compiled binary errors at runtime.
//   - sips is part of macOS, no install, no native module issue.
//   - Tier 1 is macOS-only anyway.
//
// Linux/Windows port (Phase 2) will need a different impl. The interface
// stays the same; only this class changes.

import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thumbnailer } from "./adapter.ts";

const JPEG_QUALITY_STEPS = [80, 70, 60, 50, 40, 30] as const;

export class BunThumbnailer implements Thumbnailer {
    async generateImageThumbnail(
        path: string,
        maxDimension: number,
        maxSize: number,
    ): Promise<Uint8Array> {
        // Each call uses its own scratch dir so concurrent uploads don't
        // collide. Cleaned up regardless of success/failure.
        const scratch = join(
            tmpdir(),
            `coralstack-thumb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        mkdirSync(scratch, { recursive: true });

        try {
            for (const quality of JPEG_QUALITY_STEPS) {
                const out = join(scratch, `thumb-q${quality}.jpg`);
                const proc = Bun.spawn({
                    cmd: [
                        "sips",
                        "-s", "format", "jpeg",
                        "-s", "formatOptions", String(quality),
                        "-Z", String(maxDimension),
                        path,
                        "--out", out,
                    ],
                    stdout: "ignore",
                    stderr: "pipe",
                });
                const exitCode = await proc.exited;
                if (exitCode !== 0) {
                    const err = await new Response(proc.stderr).text();
                    throw new Error(
                        `sips failed (exit ${exitCode}): ${err.trim()}`,
                    );
                }
                const size = statSync(out).size;
                if (size <= maxSize) {
                    return new Uint8Array(readFileSync(out));
                }
            }
            // All quality steps exhausted; return the smallest we got.
            const last = join(scratch, `thumb-q30.jpg`);
            return new Uint8Array(readFileSync(last));
        } finally {
            try { rmSync(scratch, { recursive: true, force: true }); } catch {}
        }
    }
}
