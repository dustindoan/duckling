// drain.ts — continuous upload-and-delete loop over a staging directory
// (e.g. an FSKit-mounted export drive), folded in from waddle's src/drain.ts.
//
// [Note: why drain spawns a duckling child instead of calling in-process]
//
// duckling — because it runs ente's own upload/crypto code — has known
// JS-level memory growth over long sessions, and a wedged upload has no
// clean cancellation (no AbortController in ente's HTTP layer — see
// base/http.ts — so a hung request can only be reclaimed by killing the
// process it's running in). Both properties are inherent to running
// ente's TS upload pipeline at all, not an artifact of any particular
// process topology.
//
// So `duckling drain` keeps the exact process shape waddle proved out:
// this file is an orchestrator that never builds its own Dispatcher or
// touches ente's code, and does all upload work through a `DucklingClient`
// (drain-client.ts) that spawns duckling itself as a subordinate. The
// orchestrator's own memory stays flat forever; rotation and wedge
// recovery both reduce to "kill the child, spawn another, replay
// auth.restore + collections.list" — a proven, cheap operation, not a
// process-exit request to whatever's supervising `duckling drain`.
// External contract: `duckling drain` runs until told to stop (--once
// finishes and exits; SIGINT/SIGTERM stop it); anything supervising it
// only needs to restart it if it actually dies.

import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { DucklingClient } from "./drain-client.ts";
import { clusterLivePhotos, MAX_LIVE_HALF_BYTES, type StagedFile } from "./pairing.ts";

const err = (s: string): void => void process.stderr.write(s + "\n");

export const INFLIGHT_PREFIX = ".inflight-";

const LIVE_IMAGE_EXTS = new Set([
    ".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".dng",
    ".webp", ".avif", ".gif",
]);
const LIVE_VIDEO_EXTS = new Set([".mov", ".mp4", ".m4v"]);

export interface DrainTotals {
    uploaded: number;
    livePairs: number;
    present: number;
    failed: number;
    skippedAae: number;
    skippedUnsupported: number;
}

export const newTotals = (): DrainTotals => ({
    uploaded: 0,
    livePairs: 0,
    present: 0,
    failed: 0,
    skippedAae: 0,
    skippedUnsupported: 0,
});

export interface DrainDeps {
    client: DucklingClient;
    collectionID: number;
    totals: DrainTotals;
    /** Per-upload ceiling before the child is declared wedged and rotated.
     * There is no AbortController on ente's fetch layer, so this doesn't
     * cancel the in-flight request — it gives up waiting and kills the
     * child, which reclaims it (see the file header). */
    uploadTimeoutMs: number;
    maxAttemptsPerFile: number;
    /** Rotate (kill + respawn the child) after this many uploads. Bounds
     * the JS-level memory growth long ente upload sessions exhibit. */
    rotateEvery: number;
}

/** Creates the batch drainer. Stateful across calls (including across
 * child rotations — only the child restarts, not this orchestrator): per-
 * path attempt counts survive so a persistently failing file cannot spin
 * a watch loop forever. */
export const createDrainer = (deps: DrainDeps) => {
    const attempts = new Map<string, number>();
    const failedPaths = new Set<string>();

    const maybeRotate = async (): Promise<void> => {
        if (deps.client.uploadsSinceSpawn < deps.rotateEvery) return;
        err(`drain: rotating duckling after ${deps.client.uploadsSinceSpawn} uploads`);
        await deps.client.rotate();
    };

    // ente's UploadResult union, by what the staged file's fate should be.
    const PERMANENT_SKIPS = new Set([
        "unsupported",
        "zeroSize",
        "tooLarge",
        "largerThanAvailableStorage",
    ]);

    const finish = (result: unknown, files: StagedFile[]): boolean => {
        const type =
            result && typeof result === "object" && "type" in result
                ? String((result as { type: unknown }).type)
                : "unknown";
        const names = files.map((f) => basename(f.path)).join(" + ");
        if (type === "uploaded" || type === "uploadedWithStaticThumbnail") {
            for (const f of files) rmSync(f.path, { force: true });
            deps.totals.uploaded++;
            return true;
        } else if (type === "alreadyUploaded" || type === "addedSymlink") {
            for (const f of files) rmSync(f.path, { force: true });
            deps.totals.present++;
        } else if (PERMANENT_SKIPS.has(type)) {
            for (const f of files) rmSync(f.path, { force: true });
            deps.totals.skippedUnsupported++;
            err(`drain: – ${names} (${type}, skipped)`);
        } else {
            for (const f of files) {
                attempts.set(f.path, (attempts.get(f.path) ?? 0) + 1);
                failedPaths.add(f.path);
            }
            deps.totals.failed = failedPaths.size;
            err(`drain: ✗ ${names} (${type})`);
        }
        return false;
    };

    const failedCall = async (e: unknown, files: StagedFile[]): Promise<void> => {
        const msg = e instanceof Error ? e.message : String(e);
        for (const f of files) {
            attempts.set(f.path, (attempts.get(f.path) ?? 0) + 1);
            failedPaths.add(f.path);
        }
        deps.totals.failed = failedPaths.size;
        err(`drain: ✗ ${files.map((f) => basename(f.path)).join(" + ")}: ${msg}`);
        if (
            msg.includes("timed out") ||
            msg.includes("duckling exited") ||
            msg.includes("duckling not running") ||
            msg.includes("duckling worker stopped")
        ) {
            err("drain: worker unusable — rotating duckling");
            await deps.client.rotate();
        }
    };

    /** Upload one batch of staged paths; delete each on confirmation.
     * Returns how many files were acted on (uploaded/skipped/failed —
     * anything except "ignored because attempts are exhausted"), so the
     * watch loop can tell real progress from a staging dir that only
     * contains permanently failing files. */
    const drainBatch = async (paths: string[]): Promise<number> => {
        let acted = 0;
        const staged: StagedFile[] = [];
        for (const path of paths) {
            if (basename(path).startsWith(".")) continue;
            if (path.toLowerCase().endsWith(".aae")) {
                // Photos edit sidecars: ente has no type for them and the
                // museum refuses them. Deleting is safe — they're export
                // copies, re-derivable from Photos at any time.
                rmSync(path, { force: true });
                deps.totals.skippedAae++;
                acted++;
                continue;
            }
            if ((attempts.get(path) ?? 0) >= deps.maxAttemptsPerFile) continue;
            let size: number;
            try {
                size = statSync(path).size;
            } catch {
                continue; // vanished between scan and drain
            }
            staged.push({ path, size });
        }
        if (staged.length === 0) return acted;

        const { pairs, singles } = clusterLivePhotos(staged);
        err(
            `drain: draining ${staged.length} file(s) — ${pairs.length} live pair(s), ${singles.length} single(s)`,
        );

        for (const pair of pairs) {
            try {
                const result = await deps.client.call(
                    "upload.put_live_photo",
                    {
                        stillPath: pair.still.path,
                        motionPath: pair.motion.path,
                        collectionID: deps.collectionID,
                    },
                    deps.uploadTimeoutMs,
                );
                deps.client.uploadsSinceSpawn++;
                if (finish(result, [pair.still, pair.motion]))
                    deps.totals.livePairs++;
            } catch (e) {
                await failedCall(e, [pair.still, pair.motion]);
            }
            await maybeRotate();
        }
        for (const single of singles) {
            try {
                const result = await deps.client.call(
                    "upload.put_file",
                    { path: single.path, collectionID: deps.collectionID },
                    deps.uploadTimeoutMs,
                );
                deps.client.uploadsSinceSpawn++;
                finish(result, [single]);
            } catch (e) {
                await failedCall(e, [single]);
            }
            acted++;
            await maybeRotate();
        }
        return acted + pairs.length * 2;
    };

    return {
        drainBatch,
        /** Paths that exhausted their attempts (left in staging). */
        exhausted: (): string[] =>
            [...attempts.entries()]
                .filter(([, n]) => n >= deps.maxAttemptsPerFile)
                .map(([p]) => p)
                .filter((p) => existsSync(p)),
    };
};

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

export interface WatchOptions {
    staging: string;
    quiesceSecs: number;
    zeroByteQuiesceSecs: number;
    pairGraceSecs: number;
    pollSecs: number;
    once: boolean;
    statusFile?: string;
    /** A sentinel whose own mtime is older than this is treated as stale
     * and ignored (the file underneath still passes normal quiesce). The
     * mount heartbeats sentinel mtimes on every write, but FSKit doesn't
     * deliver closeItem for every writer pattern and suspended appexes
     * can't run cleanup timers — so staleness is judged here, where the
     * clock always ticks. Default 900s. */
    sentinelTtlSecs?: number;
}

interface ScanEntry {
    path: string;
    size: number;
    mtimeMs: number;
}

/** One snapshot of the staging dir (flat — Photos exports flat, and the
 * mount is flat), split into eligible files and the reasons others wait. */
export interface ScanResult {
    eligible: ScanEntry[];
    inflight: number; // sentinel'd
    unquiesced: number; // mtime too fresh (incl. zero-byte long quiesce)
    deferredForPair: number; // waiting for a live mate
}

const isLiveHalfCandidate = (e: ScanEntry): "image" | "video" | null => {
    if (e.size >= MAX_LIVE_HALF_BYTES) return null;
    const ext = extname(e.path).toLowerCase();
    if (LIVE_IMAGE_EXTS.has(ext)) return "image";
    if (LIVE_VIDEO_EXTS.has(ext)) return "video";
    return null;
};

const stem = (p: string): string => {
    const name = basename(p);
    return name.slice(0, name.length - extname(name).length).toLowerCase();
};

/** firstSeen tracking lives across scans so pair-grace is measured from
 * first sighting, not per-scan. */
export const scanStaging = (
    opts: WatchOptions,
    firstSeen: Map<string, number>,
    now: number,
): ScanResult => {
    const result: ScanResult = {
        eligible: [],
        inflight: 0,
        unquiesced: 0,
        deferredForPair: 0,
    };
    if (!existsSync(opts.staging)) return result;

    const names = readdirSync(opts.staging, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
    const ttlMs = (opts.sentinelTtlSecs ?? 900) * 1000;
    const sentinels = new Set(
        names
            .filter((n) => {
                if (!n.startsWith(INFLIGHT_PREFIX)) return false;
                try {
                    const st = statSync(join(opts.staging, n));
                    return now - st.mtimeMs < ttlMs; // stale = ignore
                } catch {
                    return false;
                }
            })
            .map((n) => n.slice(INFLIGHT_PREFIX.length)),
    );
    const visible = names.filter((n) => !n.startsWith(".")).sort();

    // Pass 1: classify each file by sentinel + quiesce.
    const settled: ScanEntry[] = [];
    const unsettledStems = new Set<string>();
    for (const name of visible) {
        const path = join(opts.staging, name);
        let st;
        try {
            st = statSync(path);
        } catch {
            continue;
        }
        if (!firstSeen.has(path)) firstSeen.set(path, now);
        if (sentinels.has(name)) {
            result.inflight++;
            unsettledStems.add(stem(name));
            continue;
        }
        const quiesceMs =
            (st.size === 0 ? opts.zeroByteQuiesceSecs : opts.quiesceSecs) * 1000;
        if (now - st.mtimeMs < quiesceMs) {
            result.unquiesced++;
            unsettledStems.add(stem(name));
            continue;
        }
        settled.push({ path, size: st.size, mtimeMs: st.mtimeMs });
    }

    // Pass 2: pair grace. Hold a settled live-half candidate back if its
    // mate is visible-but-unsettled, or if no mate has appeared yet and the
    // grace window since first sighting hasn't elapsed.
    const settledKinds = new Map<string, Set<string>>();
    for (const e of settled) {
        const kind = isLiveHalfCandidate(e);
        if (!kind) continue;
        const s = stem(e.path);
        const kinds = settledKinds.get(s) ?? new Set();
        kinds.add(kind);
        settledKinds.set(s, kinds);
    }
    for (const e of settled) {
        const kind = isLiveHalfCandidate(e);
        if (kind) {
            const s = stem(e.path);
            if (unsettledStems.has(s)) {
                result.deferredForPair++;
                continue; // mate is mid-write — wait for it
            }
            const kinds = settledKinds.get(s)!;
            const hasMate = kinds.has(kind === "image" ? "video" : "image");
            const graceOver =
                now - (firstSeen.get(e.path) ?? now) >=
                opts.pairGraceSecs * 1000;
            if (!hasMate && !graceOver) {
                result.deferredForPair++;
                continue; // mate may still arrive
            }
        }
        result.eligible.push(e);
    }

    // Drop firstSeen entries for files that no longer exist (bounded memory).
    for (const p of firstSeen.keys())
        if (!existsSync(p)) firstSeen.delete(p);

    return result;
};

export interface WatchStatus {
    pid: number;
    startedAt: string;
    staging: string;
    album: string;
    state: "draining" | "idle" | "stopped";
    totals: DrainTotals;
    stagingFiles: number;
    stagingBytes: number;
    inflight: number;
    unquiesced: number;
    deferredForPair: number;
    exhausted: string[];
    updatedAt: string;
}

export const writeStatus = (file: string, status: WatchStatus): void => {
    try {
        writeFileSync(file, JSON.stringify(status, null, 2));
    } catch {
        // status is best-effort observability; never fail the drain over it
    }
};

const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

export interface WatchDeps {
    drainer: ReturnType<typeof createDrainer>;
    totals: DrainTotals;
    album: string;
}

/** The continuous loop. Resolves when: --once and staging is drained; or a
 * SIGINT/SIGTERM arrived (finishes the in-progress batch first). Rotation
 * and wedge recovery happen inside drainBatch (via the DucklingClient) and
 * never cause this loop to stop. */
export const runWatch = async (
    opts: WatchOptions,
    deps: WatchDeps,
): Promise<void> => {
    let stopping = false;
    const stop = (): void => {
        if (stopping) return;
        stopping = true;
        err("drain: stopping after current upload …");
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    const firstSeen = new Map<string, number>();
    const startedAt = new Date().toISOString();

    const snapshotStatus = (
        scan: ScanResult,
        state: WatchStatus["state"],
    ): void => {
        if (!opts.statusFile) return;
        let stagingFiles = 0;
        let stagingBytes = 0;
        try {
            for (const e of readdirSync(opts.staging, { withFileTypes: true })) {
                if (!e.isFile() || e.name.startsWith(".")) continue;
                stagingFiles++;
                try {
                    stagingBytes += statSync(join(opts.staging, e.name)).size;
                } catch {}
            }
        } catch {}
        writeStatus(opts.statusFile, {
            pid: process.pid,
            startedAt,
            staging: opts.staging,
            album: deps.album,
            state,
            totals: deps.totals,
            stagingFiles,
            stagingBytes,
            inflight: scan.inflight,
            unquiesced: scan.unquiesced,
            deferredForPair: scan.deferredForPair,
            exhausted: deps.drainer.exhausted().map((p) => basename(p)),
            updatedAt: new Date().toISOString(),
        });
    };

    while (!stopping) {
        const scan = scanStaging(opts, firstSeen, Date.now());
        let acted = 0;
        if (scan.eligible.length > 0) {
            snapshotStatus(scan, "draining");
            acted = await deps.drainer.drainBatch(
                scan.eligible.map((e) => e.path),
            );
            snapshotStatus(scanStaging(opts, firstSeen, Date.now()), "idle");
            if (acted > 0) continue; // rescan immediately — more may have settled
            // eligible files remained but none were actionable (attempts
            // exhausted) — fall through to the idle wait instead of spinning
        } else {
            snapshotStatus(scan, "idle");
        }
        const pendingWork =
            scan.inflight + scan.unquiesced + scan.deferredForPair > 0;
        if (opts.once && !pendingWork && acted === 0) break;
        await sleep(
            (opts.once ? Math.min(opts.pollSecs, 2) : opts.pollSecs) * 1000,
        );
    }

    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (opts.statusFile)
        snapshotStatus(scanStaging(opts, firstSeen, Date.now()), "stopped");
};
