// BunFFmpegRunner — native-ffmpeg implementation of FFmpegRunner.
//
// Replaces electron.ffmpegExec and electron.ffmpegDetermineVideoDuration.
// ente expects to be running inside an Electron host that bundles ffmpeg
// via the `ffmpeg-static` npm package; the helper does not, so we shell
// out to a real ffmpeg binary instead.
//
// **Binary resolution order** (first hit wins):
//   1. `DUCKLING_FFMPEG_PATH` env var (or legacy `CORALSTACK_FFMPEG_PATH`,
//      kept for the CoralStack app).
//   2. A `ffmpeg` file living next to the helper binary
//      (`Bundle.main.url(forResource: "ffmpeg")` on macOS apps).
//   3. `ffmpeg` on PATH (`which ffmpeg`).
//
// In the .app deployment we ship ffmpeg in `Contents/Resources/` (same
// place as `ente-helper`), so #2 resolves. For CLI dev / smoke tests
// the system ffmpeg (homebrew typically) handles #3.
//
// **HDR detection** mirrors ente's Electron host (`isHDRVideo` in
// ente/desktop/src/main/services/ffmpeg-worker.ts): run the same
// pseudo-ffprobe pass used for duration, then look for the HDR colour
// transfers ("smpte2084", "arib-std-b67") in the video stream line.
// Probe failures fall back to `.default` — upstream documents the false
// negative as the lesser evil, since tonemapping a non-HDR file fails
// with "no path between colorspaces" while SDR rendering of an HDR
// video is merely washed out.
//
// Pattern borrowed from BunThumbnailer: scratch dir per call, cleanup
// on success or failure, no shared state.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
    FFmpegCommand,
    FFmpegRunner,
    ZipItem,
} from "./adapter.ts";

// Mirror ente's placeholder constants. See
// `ente/web/packages/gallery/services/ffmpeg/constants.ts`. Changing these
// values would silently break ente's command templates.
const FFMPEG_PLACEHOLDER = "FFMPEG";
const INPUT_PLACEHOLDER = "INPUT";
const OUTPUT_PLACEHOLDER = "OUTPUT";

export class BunFFmpegRunner implements FFmpegRunner {
    /** Cached after first resolution. */
    private ffmpegPath: string | undefined;

    async exec(
        command: FFmpegCommand,
        pathOrZipItem: string | ZipItem,
        outputFileExtension: string,
    ): Promise<Uint8Array> {
        return await this.withScratch(async (scratch) => {
            const inputPath = await this.materializeInput(
                pathOrZipItem,
                scratch,
            );
            const outputPath = join(scratch, `output.${outputFileExtension}`);

            const resolved = Array.isArray(command)
                ? command
                : (await this.isHDRVideo(inputPath))
                  ? command.hdr
                  : command.default;
            const cmd = this.substitutePlaceholders(
                resolved,
                inputPath,
                outputPath,
            );

            await this.spawnFFmpeg(cmd);

            if (!existsSync(outputPath)) {
                throw new Error(
                    `ffmpeg exited 0 but did not produce ${outputPath}`,
                );
            }
            return new Uint8Array(readFileSync(outputPath));
        });
    }

    async determineVideoDuration(
        pathOrZipItem: string | ZipItem,
    ): Promise<number> {
        return await this.withScratch(async (scratch) => {
            const inputPath = await this.materializeInput(
                pathOrZipItem,
                scratch,
            );
            return parseDurationFromStderr(
                await this.pseudoFFProbe(inputPath),
            );
        });
    }

    // ─── helpers ─────────────────────────────────────────────────────

    /**
     * ffmpeg -hide_banner -i INPUT -an -frames:v 0 -f null -
     *
     * Same shape as ente's Electron host (`pseudoFFProbeVideo` in
     * ente/desktop/src/main/services/ffmpeg-worker.ts). We rely on
     * ffmpeg writing stream info to stderr because we don't ship
     * ffprobe; ente makes the same choice for the same reason. See
     * [Note: Parsing CLI output might break on ffmpeg updates] in
     * ente's source for the long-running caveat.
     *
     * ffmpeg writes "info" to stderr; ignoring exit code matches
     * ente's behaviour. The "-frames:v 0 -f null -" command exits
     * successfully on well-formed inputs and with non-zero on truly
     * broken files; either way callers parse what we have.
     */
    private async pseudoFFProbe(inputPath: string): Promise<string> {
        const cmd = [
            await this.binaryPath(),
            "-hide_banner",
            "-i", inputPath,
            "-an",
            "-frames:v", "0",
            "-f", "null",
            "-",
        ];
        const proc = Bun.spawn({
            cmd,
            stdout: "ignore",
            stderr: "pipe",
        });
        const stderr = await new Response(proc.stderr).text();
        await proc.exited;
        return stderr;
    }

    /**
     * Heuristically detect whether the video is HDR, to pick between the
     * `default` and `hdr` variants of an ente command template. Mirrors
     * upstream's `isHDRVideo`; probe failures return false (see the
     * header comment for why false negatives are the safe direction).
     */
    private async isHDRVideo(inputPath: string): Promise<boolean> {
        try {
            return stderrIndicatesHDR(await this.pseudoFFProbe(inputPath));
        } catch {
            return false;
        }
    }

    /**
     * Resolve and cache the ffmpeg binary path. Throws a clear error if
     * nothing is found — the upload pipeline catches it and continues
     * without duration/thumbnail metadata, so a bad path manifests as
     * "videos in ente have no thumbnails" rather than "uploads fail."
     */
    private async binaryPath(): Promise<string> {
        if (this.ffmpegPath) return this.ffmpegPath;

        const fromEnv =
            process.env.DUCKLING_FFMPEG_PATH ??
            process.env.CORALSTACK_FFMPEG_PATH;
        if (fromEnv && existsSync(fromEnv)) {
            this.ffmpegPath = fromEnv;
            return fromEnv;
        }

        // Sibling of the helper binary — `Bundle.main.url(forResource:
        // "ffmpeg")` in the .app maps to `Contents/Resources/ffmpeg`,
        // which is where the helper itself lives.
        const sibling = join(dirname(process.execPath), "ffmpeg");
        if (existsSync(sibling)) {
            this.ffmpegPath = sibling;
            return sibling;
        }

        // System PATH. Bun.which is cross-platform (the previous
        // /usr/bin/which spawn was macOS-shaped).
        const onPath = Bun.which("ffmpeg");
        if (onPath) {
            this.ffmpegPath = onPath;
            return onPath;
        }

        throw new Error(
            "ffmpeg not found. Set DUCKLING_FFMPEG_PATH, place a binary " +
            "next to the duckling executable, or install ffmpeg system-wide.",
        );
    }

    /**
     * Place ZipItem entries on disk so ffmpeg can read them. Plain paths
     * pass through unchanged.
     */
    private async materializeInput(
        pathOrZipItem: string | ZipItem,
        scratch: string,
    ): Promise<string> {
        if (typeof pathOrZipItem === "string") return pathOrZipItem;

        const [zipPath, entryName] = pathOrZipItem;
        // Lazy-load jszip — it's only needed for the zip case, and
        // ene's Photos.app FP path never goes through it.
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(readFileSync(zipPath));
        const entry = zip.file(entryName);
        if (!entry) {
            throw new Error(
                `Zip entry ${entryName} not found in ${zipPath}`,
            );
        }
        // Preserve the entry's extension so any path-extension-sensitive
        // ffmpeg flags work correctly.
        const ext = entryName.includes(".")
            ? entryName.slice(entryName.lastIndexOf("."))
            : "";
        const out = join(scratch, `input${ext}`);
        await Bun.write(out, await entry.async("uint8array"));
        return out;
    }

    private substitutePlaceholders(
        command: string[],
        inputPath: string,
        outputPath: string,
    ): string[] {
        // `binaryPath()` is resolved lazily on first FFMPEG hit. We expect
        // the command to contain it; if it doesn't (some commands omit it
        // because they're spawned with a known ffmpeg-static path), we
        // prepend it so the spawn call has an executable to run.
        return command.map((seg) => {
            if (seg === FFMPEG_PLACEHOLDER) return "__FFMPEG_PATH__";
            if (seg === INPUT_PLACEHOLDER) return inputPath;
            if (seg === OUTPUT_PLACEHOLDER) return outputPath;
            return seg;
        });
    }

    private async spawnFFmpeg(cmd: string[]): Promise<void> {
        // We deferred the binary path until the substitution stage so the
        // command shape stays inspectable. Swap the marker in now.
        const binary = await this.binaryPath();
        const resolved = cmd.map((s) =>
            s === "__FFMPEG_PATH__" ? binary : s
        );
        // If the command didn't include FFMPEG_PLACEHOLDER at all (some
        // ente templates omit it because they assume a known binary
        // path), prepend it so we have something to exec.
        if (!resolved.length || resolved[0] !== binary) {
            // Heuristic: if argv[0] looks like an ffmpeg flag (starts
            // with "-"), the binary really is missing.
            if (resolved[0]?.startsWith("-")) {
                resolved.unshift(binary);
            }
        }

        const proc = Bun.spawn({
            cmd: resolved,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [_, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (code !== 0) {
            throw new Error(
                `ffmpeg exited ${code}: ${stderr.trim().slice(0, 500)}`,
            );
        }
    }

    private async withScratch<T>(
        fn: (scratch: string) => Promise<T>,
    ): Promise<T> {
        const scratch = join(
            tmpdir(),
            `coralstack-ffmpeg-${process.pid}-${Date.now()}-` +
                Math.random().toString(36).slice(2),
        );
        mkdirSync(scratch, { recursive: true });
        try {
            return await fn(scratch);
        } finally {
            try {
                rmSync(scratch, { recursive: true, force: true });
            } catch {
                // best-effort cleanup; don't mask the original error
            }
        }
    }
}

// ─── stderr parsing ──────────────────────────────────────────────────

// Mirrors ente's `videoStreamLineRegex` in ffmpeg-worker.ts. Matches e.g.
//
//     Stream #0:0: Video: h264 (High 10) ([27][0][0][0] / 0x001B), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 30 fps, ...
//
// with everything after "Video:" as the first capture group.
const VIDEO_STREAM_LINE_REGEX = /Stream #.+: Video:(.+)\r?\n/;

/**
 * True if ffmpeg's stderr describes an HDR video stream. Same check as
 * ente's `isHDRVideo`: HDR colour transfers (PQ / HLG) named in the
 * video stream line. No false positives expected; false negatives
 * possible — and preferable, per the header comment.
 *
 * Exported for unit testing.
 */
export const stderrIndicatesHDR = (stderr: string): boolean => {
    const vs = VIDEO_STREAM_LINE_REGEX.exec(stderr)?.at(1);
    if (!vs) return false;
    return vs.includes("smpte2084") || vs.includes("arib-std-b67");
};

// ─── duration parsing ────────────────────────────────────────────────

// Mirrors ente's `videoDurationLineRegex` in ffmpeg-worker.ts. The shape
// of the line is e.g. "  Duration: 00:00:14.83, start: 0.000000, bitrate: ...".
const VIDEO_DURATION_LINE_REGEX = /\s\sDuration: ([0-9:]+)(.[0-9]+)?/;

/**
 * Parse seconds out of ffmpeg's "Duration: HH:MM:SS.ss" stderr line.
 * Returns the rounded-up integer to match ente's web-side rounding.
 *
 * Exported for unit testing.
 */
export const parseDurationFromStderr = (stderr: string): number => {
    const matches = VIDEO_DURATION_LINE_REGEX.exec(stderr);
    const fail = () => {
        throw new Error(
            `Cannot parse video duration from ffmpeg stderr: ` +
                (matches?.[0] ?? "(no Duration line)"),
        );
    };

    const ints = (matches?.[1] ?? "")
        .split(":")
        .map((s) => parseInt(s, 10) || 0);
    let h = 0, m = 0, s = 0;
    switch (ints.length) {
        case 1: s = ints[0]!; break;
        case 2: m = ints[0]!; s = ints[1]!; break;
        case 3: h = ints[0]!; m = ints[1]!; s = ints[2]!; break;
        default: fail();
    }
    const ss = parseFloat(`0${matches?.[2] ?? ""}`);
    const duration = Math.ceil(h * 3600 + m * 60 + s + ss);
    if (!duration) fail();
    return duration;
};
