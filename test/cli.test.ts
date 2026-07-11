// CLI + stdio-protocol tests against the built binary (dist/duckling).
//
// Two tiers:
//   - offline: no session, no museum — always run. Exercises argv
//     handling, exit codes, stdout/stderr discipline, and JSON-RPC
//     protocol conformance of the stdio server.
//   - live: require DUCKLING_LIVE_TESTS=1 plus an existing login session
//     (~/.duckling/session.json), which gets COPIED into an isolated
//     state dir — tests never touch the real state. Museum traffic is a
//     handful of tiny operations against a throwaway album.
//
// Build first: `bun run build`.

import { afterAll, describe, expect, test } from "bun:test";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BIN = join(ROOT, "dist/duckling");
const REAL_SESSION = join(
    process.env.DUCKLING_STATE_DIR ?? join(homedir(), ".duckling"),
    "session.json",
);
const LIVE = process.env.DUCKLING_LIVE_TESTS === "1" && existsSync(REAL_SESSION);
// Unique pixels per run: ente dedups by content hash account-wide, so a
// deterministic fixture matches its own previous run forever.
const randChan = () => Math.floor(Math.random() * 256);
const TEST_ALBUM = "duckling-cli-test";

if (!existsSync(BIN)) throw new Error("build dist/duckling first");

interface Run {
    exitCode: number;
    stdout: string;
    stderr: string;
}

const freshStateDir = (withSession = false): string => {
    const dir = mkdtempSync(join(tmpdir(), "duckling-test-"));
    if (withSession) copyFileSync(REAL_SESSION, join(dir, "session.json"));
    return dir;
};

const run = (
    args: string[],
    opts: { stdin?: string; state?: string; env?: Record<string, string> } = {},
): Run => {
    const proc = Bun.spawnSync([BIN, ...args], {
        env: {
            ...process.env,
            DUCKLING_STATE_DIR: opts.state ?? freshStateDir(),
            ...(opts.env ?? {}),
        },
        stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : undefined,
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
    };
};

describe("argv surface", () => {
    test("--version prints only the version on stdout", () => {
        const r = run(["--version"]);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test("--help exits 0 and documents the verbs", () => {
        const r = run(["--help"]);
        expect(r.exitCode).toBe(0);
        for (const verb of ["login", "whoami", "ls", "upload", "call"])
            expect(r.stdout).toContain(verb);
    });

    test("unknown command exits 2 with guidance", () => {
        const r = run(["frobnicate"]);
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain("unknown command");
    });

    test("call without a method exits 2 with usage", () => {
        const r = run(["call"]);
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain("usage:");
    });

    test("call with invalid params JSON exits 2", () => {
        const r = run(["call", "ping", "{not json"]);
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain("not valid JSON");
    });

    test("call with an unknown method exits 1 with the RPC error", () => {
        const r = run(["call", "no.such.method"]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("Method not found");
    });

    test("call ping puts ONLY the result on stdout (pipe discipline)", () => {
        const r = run(["call", "ping"]);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe('"pong"\n');
    });

    test("whoami without a session exits 1 with login guidance", () => {
        const r = run(["whoami"]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("duckling login");
    });

    test("logout without a session still succeeds", () => {
        const r = run(["logout"]);
        expect(r.exitCode).toBe(0);
    });

    test("upload without --album exits 2 with usage", () => {
        const r = run(["upload", "/tmp/x.jpg"]);
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain("usage: duckling upload");
    });

    test("upload of a nonexistent path exits 2", () => {
        const r = run(["upload", "/no/such/file.jpg", "--album", "x"]);
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain("no such path");
    });

    test("login with immediate EOF exits 2, not a hang", () => {
        const r = run(["login"], { stdin: "" });
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain("email required");
    });

    test("endpoint env override is honored (visible in diagnostics)", () => {
        const r = run(["call", "ping"], {
            env: { DUCKLING_ENDPOINT: "https://museum.invalid" },
        });
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toContain("museum: https://museum.invalid");
    });
});

describe("stdio JSON-RPC server", () => {
    test("every stdout line is valid JSON; garbage and unknowns answered per spec", () => {
        const requests =
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) +
            "\n" +
            "this is not json\n" +
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "no.such" }) +
            "\n" +
            JSON.stringify({ jsonrpc: "2.0", id: 3, method: "version" }) +
            "\n";
        const r = run([], { stdin: requests });
        const lines = r.stdout.split("\n").filter(Boolean);
        // Protocol discipline: nothing non-JSON may ever reach stdout.
        const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(parsed).toHaveLength(4);
        expect(parsed[0]).toMatchObject({ id: 1, result: "pong" });
        expect(parsed[1]).toMatchObject({
            id: null,
            error: { code: -32700 },
        });
        expect(parsed[2]).toMatchObject({
            id: 2,
            error: { code: -32601 },
        });
        expect(parsed[3]).toMatchObject({ id: 3 });
    });

    test("notifications (no id) execute silently — no response line", () => {
        const requests =
            JSON.stringify({ jsonrpc: "2.0", method: "ping" }) +
            "\n" +
            JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) +
            "\n";
        const r = run([], { stdin: requests });
        const lines = r.stdout.split("\n").filter(Boolean);
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toMatchObject({ id: 9, result: "pong" });
    });

    test("pipelined requests in one write all get answered in order", () => {
        const requests = [1, 2, 3, 4, 5]
            .map((id) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }))
            .join("\n");
        const r = run([], { stdin: requests + "\n" });
        const ids = r.stdout
            .split("\n")
            .filter(Boolean)
            .map((l) => (JSON.parse(l) as { id: number }).id);
        expect(ids).toEqual([1, 2, 3, 4, 5]);
    });
});

describe.if(LIVE)("live museum (isolated session copy)", () => {
    const state = LIVE ? freshStateDir(true) : "";
    const fixtures = mkdtempSync(join(tmpdir(), "duckling-fixtures-"));

    afterAll(() => {
        // Best-effort: remove the throwaway album.
        const ls = run(["ls"], { state });
        const id = ls.stdout
            .split("\n")
            .find((l) => l.includes(TEST_ALBUM))
            ?.trim()
            .split(/\s+/)[0];
        if (id) run(["call", "collections.delete", `{"id":${id}}`], { state });
    });

    test(
        "whoami works from a copied session in an isolated state dir",
        () => {
            const r = run(["whoami"], { state });
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("@");
        },
        30_000,
    );

    test("upload → dedup → unicode album name round trip", async () => {
        const sharp = (await import("sharp")).default;
        const img = join(fixtures, "café 📷.jpg");
        await sharp({
            create: {
                width: 64,
                height: 64,
                channels: 3,
                background: { r: randChan(), g: randChan(), b: randChan() },
            },
        })
            .jpeg()
            .toFile(img);

        const first = run(["upload", img, "--album", TEST_ALBUM], { state });
        expect(first.exitCode).toBe(0);
        expect(first.stdout).toContain("✓ café 📷.jpg");

        const again = run(["upload", img, "--album", TEST_ALBUM], { state });
        expect(again.exitCode).toBe(0);
        expect(again.stdout).toContain("already in ente");

        const ls = run(["ls"], { state });
        expect(ls.stdout).toContain(TEST_ALBUM);
    }, 90_000);

    test("zero-byte and unsupported files fail cleanly, exit 1", () => {
        const zero = join(fixtures, "zero.jpg");
        const txt = join(fixtures, "notes.txt");
        writeFileSync(zero, "");
        writeFileSync(txt, "plain text");
        const r = run(["upload", zero, txt, "--album", TEST_ALBUM], { state });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain("✗");
        expect(r.stdout).toContain("2 failed");
    }, 90_000);

    test(
        "live photo pair uploads as one ente livePhoto",
        async () => {
            const sharp = (await import("sharp")).default;
            const still = join(fixtures, "IMG_9001.jpg");
            const motion = join(fixtures, "IMG_9001.mov");
            await sharp({
                create: {
                    width: 320,
                    height: 240,
                    channels: 3,
                    background: { r: randChan(), g: randChan(), b: randChan() },
                },
            })
                .jpeg()
                .toFile(still);
            const ff = Bun.spawnSync([
                "ffmpeg", "-y", "-f", "lavfi", "-i",
                "color=c=red:s=320x240:d=1", "-pix_fmt", "yuv420p", motion,
            ], { stdout: "ignore", stderr: "ignore" });
            expect(ff.exitCode).toBe(0);

            const created = run(
                ["call", "collections.create", `{"name":"${TEST_ALBUM}-pair"}`],
                { state },
            );
            expect(created.exitCode).toBe(0);
            const collectionID = (
                JSON.parse(created.stdout) as { id: number }
            ).id;

            const r = run(
                [
                    "call",
                    "upload.put_live_photo",
                    JSON.stringify({
                        stillPath: still,
                        motionPath: motion,
                        collectionID,
                    }),
                ],
                { state },
            );
            expect(r.exitCode).toBe(0);
            const result = JSON.parse(r.stdout) as {
                type: string;
                file?: { id: number };
            };
            expect(result.type).toMatch(/^upload/);
            expect(result.file?.id).toBeGreaterThan(0);

            // One file entry in the album — not two halves.
            const listed = run(
                [
                    "call",
                    "collections.list_files",
                    `{"id":${collectionID}}`,
                ],
                { state },
            );
            const files = (
                JSON.parse(listed.stdout) as {
                    files: { name: string; fileType: number }[];
                }
            ).files;
            expect(files).toHaveLength(1);
            expect(files[0]!.name).toBe("IMG_9001.jpg");
            run(["call", "collections.delete", `{"id":${collectionID}}`], {
                state,
            });
        },
        120_000,
    );

    test(
        "download round-trip returns byte-identical content (crypto integrity)",
        async () => {
            const sharp = (await import("sharp")).default;
            const original = join(fixtures, "roundtrip.jpg");
            await sharp({
                create: {
                    width: 200,
                    height: 200,
                    channels: 3,
                    background: { r: randChan(), g: randChan(), b: randChan() },
                },
            })
                .jpeg({ quality: 92 })
                .toFile(original);

            const created = run(
                ["call", "collections.create", `{"name":"${TEST_ALBUM}-rt"}`],
                { state },
            );
            const collectionID = (
                JSON.parse(created.stdout) as { id: number }
            ).id;
            const up = run(
                [
                    "call",
                    "upload.put_file",
                    JSON.stringify({ path: original, collectionID }),
                ],
                { state },
            );
            expect(up.exitCode).toBe(0);
            const fileID = (
                JSON.parse(up.stdout) as { file: { id: number } }
            ).file.id;

            const down = run(
                [
                    "call",
                    "download.get_file",
                    JSON.stringify({ fileID, collectionID }),
                ],
                { state },
            );
            expect(down.exitCode).toBe(0);
            const { path: downloadedPath } = JSON.parse(down.stdout) as {
                path: string;
            };
            const a = new Uint8Array(await Bun.file(original).arrayBuffer());
            const b = new Uint8Array(
                await Bun.file(downloadedPath).arrayBuffer(),
            );
            expect(b.length).toBe(a.length);
            expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);

            // rename + trash smoke on the same file.
            const renamed = run(
                [
                    "call",
                    "files.rename",
                    JSON.stringify({
                        fileID,
                        collectionID,
                        newName: "renamed.jpg",
                    }),
                ],
                { state },
            );
            expect(renamed.exitCode).toBe(0);
            const trashed = run(
                ["call", "files.trash", JSON.stringify({ fileID, collectionID })],
                { state },
            );
            expect(trashed.exitCode).toBe(0);
            run(["call", "collections.delete", `{"id":${collectionID}}`], {
                state,
            });
        },
        120_000,
    );

    test("two concurrent instances sharing one state dir both succeed", async () => {
        const spawn = () =>
            Bun.spawn([BIN, "call", "collections.list"], {
                env: { ...process.env, DUCKLING_STATE_DIR: state },
                stdout: "pipe",
                stderr: "pipe",
            });
        const [a, b] = [spawn(), spawn()];
        const [ea, eb] = await Promise.all([a.exited, b.exited]);
        expect(ea).toBe(0);
        expect(eb).toBe(0);
    }, 60_000);
});

// Ensure mkdirSync import is used even when LIVE is false.
void mkdirSync;
