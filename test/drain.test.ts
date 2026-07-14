// scanStaging unit coverage (sentinels, quiesce, pair grace) — ported from
// waddle's test/drain.test.ts. This is the logic that decides whether a
// staged file is safe to upload-and-DELETE, so the adversarial cases the
// FSKit-mount flow creates are all here: files still being written,
// stalled iCloud downloads (zero-byte lulls), late Live-Photo mates, and
// crashed writers (stale sentinels).
//
// waddle also had a CLI-level integration tier driving the drain loop
// against a scriptable mock duckling (worker crash mid-upload, timeout
// rotation, SIGINT, crash-resume). That tier injected the mock via
// WADDLE_DUCKLING_PATH, which has no equivalent here — drain-client
// self-spawns this same binary. Porting it means adding a test-only
// worker-command override; deferred until waddle is archived.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INFLIGHT_PREFIX, scanStaging } from "../src/drain.ts";

const OPTS = {
    staging: "",
    quiesceSecs: 5,
    zeroByteQuiesceSecs: 600,
    pairGraceSecs: 15,
    pollSecs: 1,
    once: false,
};

/** A staging dir where every listed file has an mtime `ageSecs` old. */
const makeStaging = (
    files: Record<string, { content?: string; ageSecs?: number }>,
): string => {
    const dir = mkdtempSync(join(tmpdir(), "duckling-scan-"));
    for (const [name, spec] of Object.entries(files)) {
        const p = join(dir, name);
        writeFileSync(p, spec.content ?? `content of ${name}`);
        const t = new Date(Date.now() - (spec.ageSecs ?? 60) * 1000);
        utimesSync(p, t, t);
    }
    return dir;
};

const names = (entries: { path: string }[]): string[] =>
    entries.map((e) => e.path.split("/").pop()!).sort();

/** Scan twice: once to register first sightings, once past the pair-grace
 * window — the steady-state view for files whose mates never arrive. */
const scanPastGrace = (dir: string) => {
    const firstSeen = new Map<string, number>();
    const t0 = Date.now();
    scanStaging({ ...OPTS, staging: dir }, firstSeen, t0);
    return scanStaging(
        { ...OPTS, staging: dir },
        firstSeen,
        t0 + OPTS.pairGraceSecs * 1000 + 1000,
    );
};

describe("scanStaging", () => {
    test("dotfiles are invisible; settled files are eligible", () => {
        const dir = makeStaging({
            "a.jpg": {},
            ".DS_Store": {},
            ".osxphotos_export.db": {},
        });
        const scan = scanPastGrace(dir);
        expect(names(scan.eligible)).toEqual(["a.jpg"]);
    });

    test("a sentinel'd file is held no matter how old its mtime is", () => {
        const dir = makeStaging({
            "open.mov": { ageSecs: 3600 },
            [`${INFLIGHT_PREFIX}open.mov`]: {},
            "done.mov": { ageSecs: 3600 },
        });
        const scan = scanPastGrace(dir);
        expect(names(scan.eligible)).toEqual(["done.mov"]);
        expect(scan.inflight).toBe(1);
    });

    test("fresh mtime waits for quiesce; old mtime passes", () => {
        const dir = makeStaging({
            "fresh.jpg": { ageSecs: 1 },
            "old.jpg": { ageSecs: 60 },
        });
        // First scan registers sightings; second runs past pair grace but
        // re-stamps fresh.jpg's mtime so it stays inside quiesce.
        const firstSeen = new Map<string, number>();
        const t0 = Date.now();
        scanStaging({ ...OPTS, staging: dir }, firstSeen, t0);
        const later = new Date(t0 + OPTS.pairGraceSecs * 1000);
        utimesSync(join(dir, "fresh.jpg"), later, later);
        const scan = scanStaging(
            { ...OPTS, staging: dir },
            firstSeen,
            t0 + OPTS.pairGraceSecs * 1000 + 1000,
        );
        expect(names(scan.eligible)).toEqual(["old.jpg"]);
        expect(scan.unquiesced).toBe(1);
    });

    test("zero-byte files require the long quiesce (stalled downloads)", () => {
        const dir = makeStaging({
            // 60s old — far past the normal quiesce, not the zero-byte one
            "stalled.heic": { content: "", ageSecs: 60 },
            // 700s old — past even the zero-byte quiesce → genuine junk
            "junk.heic": { content: "", ageSecs: 700 },
        });
        const scan = scanPastGrace(dir);
        expect(names(scan.eligible)).toEqual(["junk.heic"]);
        expect(scan.unquiesced).toBe(1);
    });

    test("a lone live-half waits out the pair grace, then releases", () => {
        const dir = makeStaging({ "IMG_1.heic": { ageSecs: 60 } });
        const firstSeen = new Map<string, number>();
        const t0 = Date.now();
        const early = scanStaging({ ...OPTS, staging: dir }, firstSeen, t0);
        expect(early.eligible).toEqual([]);
        expect(early.deferredForPair).toBe(1);
        // grace expired (measured from first sighting)
        const late = scanStaging(
            { ...OPTS, staging: dir },
            firstSeen,
            t0 + OPTS.pairGraceSecs * 1000 + 1,
        );
        expect(names(late.eligible)).toEqual(["IMG_1.heic"]);
    });

    test("a settled half whose mate is mid-write waits for it", () => {
        const dir = makeStaging({
            "IMG_2.heic": { ageSecs: 3600 },
            "IMG_2.mov": { ageSecs: 1 }, // still being written
        });
        const scan = scanStaging(
            { ...OPTS, staging: dir },
            new Map(),
            Date.now(),
        );
        expect(scan.eligible).toEqual([]);
        expect(scan.deferredForPair).toBe(1);
        expect(scan.unquiesced).toBe(1);
    });

    test("both halves settled → both eligible in the same batch", () => {
        const dir = makeStaging({
            "IMG_3.heic": { ageSecs: 60 },
            "IMG_3.mov": { ageSecs: 60 },
        });
        const scan = scanStaging({ ...OPTS, staging: dir }, new Map(), Date.now());
        expect(names(scan.eligible)).toEqual(["IMG_3.heic", "IMG_3.mov"]);
    });

    test("files too large to be live halves skip pair grace entirely", () => {
        const dir = makeStaging({
            "IMG_4.mov": { content: "x".repeat(21 * 1024 * 1024), ageSecs: 60 },
        });
        const scan = scanStaging({ ...OPTS, staging: dir }, new Map(), Date.now());
        expect(names(scan.eligible)).toEqual(["IMG_4.mov"]);
    });

    test("a STALE sentinel (older than TTL) no longer holds its file", () => {
        const dir = makeStaging({
            "crashed.mov": { ageSecs: 3600 },
            [`${INFLIGHT_PREFIX}crashed.mov`]: { ageSecs: 1200 }, // > 900s TTL
            "live.mov": { ageSecs: 3600 },
            [`${INFLIGHT_PREFIX}live.mov`]: { ageSecs: 10 }, // fresh heartbeat
        });
        const scan = scanPastGrace(dir);
        expect(names(scan.eligible)).toEqual(["crashed.mov"]);
        expect(scan.inflight).toBe(1);
    });

    test("non-media files are eligible without pair considerations", () => {
        const dir = makeStaging({ "notes.txt": { ageSecs: 60 } });
        const scan = scanStaging({ ...OPTS, staging: dir }, new Map(), Date.now());
        expect(names(scan.eligible)).toEqual(["notes.txt"]);
    });
});
