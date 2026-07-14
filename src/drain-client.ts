// drain-client.ts — spawn duckling itself (argv-less server mode) as a
// child process and talk to it over stdio JSON-RPC.
//
// Ported from waddle's duckling-client.ts, adapted so the orchestrator
// spawns *this same binary* instead of locating an external `duckling` on
// PATH — `duckling drain` needs a subordinate to run ente's upload/crypto
// code in, for reasons the drain.ts file header explains: that code has
// known JS-level memory growth over long sessions, and a wedged upload
// (no AbortController in ente's fetch layer — see base/http.ts) can only
// be reclaimed by killing the process it's running in. Keeping the
// orchestrator itself free of that workload — it never builds its own
// Dispatcher or touches ente's code — means the orchestrator's own memory
// stays flat forever and rotation is just "kill this child, spawn
// another."
//
// Sessions are per-process: ente's localStorage/sessionStorage polyfills
// die with the child, and its in-process collection cache starts empty.
// So every (re)spawn runs the same ritual:
//
//   1. auth.restore with the SessionBundle from <state dir>/session.json
//      (written by `duckling login`)
//   2. collections.list — seeds the child's collection cache so
//      upload.put_file can target any album by ID
//
// Rotation (kill + respawn + ritual) is a first-class operation, not a
// failure path: cycling the child every N uploads is how the JS-level
// memory growth in long upload sessions stays bounded, and how a wedged
// upload gets reclaimed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./platform/sqlite-kv.ts";

const err = (s: string): void => void process.stderr.write(s + "\n");

const sessionPath = (): string => join(stateDir(), "session.json");

/** How to re-invoke this same program as a child. In the compiled binary
 * `Bun.main` is a `/$bunfs/...` virtual path and `process.execPath` is the
 * duckling binary itself, so a bare re-exec works. Under `bun run
 * src/index.ts` (dev mode) `process.execPath` is the bun binary, so the
 * child needs `bun --preserve-symlinks run <entry>` instead. */
const selfSpawnCommand = (): string[] =>
    Bun.main.startsWith("/$bunfs/")
        ? [process.execPath]
        : [process.execPath, "--preserve-symlinks", "run", Bun.main];

export interface CollectionSummary {
    id: number;
    name: string;
    type: string;
}

interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
}

export class DucklingClient {
    private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
    private pending = new Map<number, Pending>();
    private nextId = 1;
    /** Uploads dispatched since the current child spawned; the drainer
     * reads this to decide when to rotate. */
    uploadsSinceSpawn = 0;

    /** Spawn + session ritual. Returns the seeded collection list. */
    async start(): Promise<CollectionSummary[]> {
        this.proc = Bun.spawn({
            cmd: selfSpawnCommand(),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        this.uploadsSinceSpawn = 0;
        void this.readLoop(this.proc);
        void this.pumpStderr(this.proc);

        await this.call("ping", undefined, 30_000);

        const sessionFile = sessionPath();
        if (!existsSync(sessionFile)) {
            throw new Error(
                `no duckling session at ${sessionFile} — run: duckling login`,
            );
        }
        const bundle = JSON.parse(readFileSync(sessionFile, "utf8")) as unknown;
        await this.call("auth.restore", bundle, 30_000);

        const listed = (await this.call(
            "collections.list",
            undefined,
            120_000,
        )) as { collections: CollectionSummary[] };
        return listed.collections;
    }

    /** Find the target album by exact name (album/folder types behave the
     * same for uploads) or create it. */
    async ensureAlbum(name: string): Promise<number> {
        const listed = (await this.call(
            "collections.list",
            undefined,
            120_000,
        )) as { collections: CollectionSummary[] };
        const match = listed.collections.find(
            (c) =>
                c.name === name && (c.type === "album" || c.type === "folder"),
        );
        if (match) return match.id;
        const created = (await this.call(
            "collections.create",
            { name },
            60_000,
        )) as { id: number };
        err(`drain: created album "${name}" (id ${created.id})`);
        return created.id;
    }

    /** Kill the child and run the full spawn ritual again. */
    async rotate(): Promise<void> {
        await this.stop();
        await this.start();
    }

    async stop(): Promise<void> {
        const proc = this.proc;
        this.proc = null;
        if (!proc) return;
        proc.kill();
        await proc.exited;
        this.failAllPending(new Error("duckling worker stopped"));
    }

    /**
     * One JSON-RPC round trip. `timeoutMs` 0 disables the timeout — but
     * uploads should pass a generous bound so a wedged child surfaces as a
     * timeout (which the drainer answers with a rotation) instead of a
     * hang.
     */
    call(method: string, params?: unknown, timeoutMs = 0): Promise<unknown> {
        const proc = this.proc;
        if (!proc) return Promise.reject(new Error("duckling not running"));
        const id = this.nextId++;
        const line =
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        return new Promise<unknown>((resolve, reject) => {
            const entry: Pending = { resolve, reject };
            if (timeoutMs > 0) {
                entry.timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(
                        new Error(
                            `${method} timed out after ${Math.round(timeoutMs / 1000)}s`,
                        ),
                    );
                }, timeoutMs);
            }
            this.pending.set(id, entry);
            proc.stdin.write(line);
            void proc.stdin.flush();
        });
    }

    private async readLoop(
        proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    ): Promise<void> {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for await (const chunk of proc.stdout) {
                buffer += decoder.decode(chunk, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (line) this.route(line);
                }
            }
        } catch {
            // Stream torn down mid-read (rotation/kill) — fall through.
        }
        this.failAllPending(new Error("duckling exited"));
    }

    private route(line: string): void {
        let msg: {
            id?: number;
            result?: unknown;
            error?: { code: number; message: string };
        };
        try {
            msg = JSON.parse(line) as typeof msg;
        } catch {
            err(`drain: unparseable line from duckling worker: ${line.slice(0, 120)}`);
            return;
        }
        // Notifications (no id) — progress events; nothing consumes them yet.
        if (typeof msg.id !== "number") return;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
    }

    private failAllPending(reason: Error): void {
        for (const [, entry] of this.pending) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.reject(reason);
        }
        this.pending.clear();
    }

    /** The child's diagnostics belong on our stderr, tagged so they're
     * distinguishable from the orchestrator's own log lines. */
    private async pumpStderr(
        proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    ): Promise<void> {
        const decoder = new TextDecoder();
        try {
            for await (const chunk of proc.stderr) {
                const text = decoder.decode(chunk);
                for (const line of text.split("\n")) {
                    if (line.trim()) err(`[drain-worker] ${line}`);
                }
            }
        } catch {
            // Rotation tore the stream down — fine.
        }
    }
}
