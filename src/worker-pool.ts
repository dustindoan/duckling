// HelperCycler — bounds TS-side memory leaks in the helper by throwing the
// subprocess away every N files / N bytes / N minutes and starting fresh.
//
// Why it lives consumer-side, not inside the helper: the Bitwarden pattern.
// Process orchestration belongs with whoever owns the lifecycle (CLI scripts
// today, the Swift wrapper tomorrow). Keeping the helper single-purpose
// means each helper instance is exactly the thing under test, and a
// supervisor inside the helper would conflate IPC concerns we don't need.
//
// "Pool" is a slight misnomer — only one helper runs at a time. Network is
// the bottleneck for the migration use case; parallelism gains us little
// against added per-file state replay cost. If that changes later, this
// class is the seam to grow N>1.
//
// Rotation flow:
//   1. Before each upload, check rotateAfter{Files,Bytes,Millis}.
//   2. If any limit hit: kill current helper, spawn new one, replay
//      auth.restore (cheap — no SRP round trip) + collections.restore for
//      every cached collection, then resume.
//   3. Counters reset; session + collection caches survive (we hold them
//      consumer-side and re-push on each restart).

import { spawn, type ChildProcess } from "node:child_process";

/**
 * Mirrors src/rpc/methods/auth.ts:SessionBundle. Repeated here so the
 * cycler doesn't import from src/rpc (the cycler is the consumer of the
 * RPC, not part of its server side).
 */
export interface SessionBundle {
    id: number;
    email: string;
    token: string;
    masterKeyB64: string;
    publicKey: string;
    privateKey: string;
    keyAttributes: unknown;
}

export interface CyclerOptions {
    /**
     * Absolute path to the compiled `ente-helper` binary, OR the `bun`
     * entry. If `bunMode` is true, this is treated as the script path
     * passed to `bun --preserve-symlinks run`.
     */
    command: string;
    args?: string[];
    cwd?: string;
    /** Default 100. Rotate when this many uploads have completed. */
    rotateAfterFiles?: number;
    /** Default 500 MiB. Rotate when cumulative bytes uploaded crosses this. */
    rotateAfterBytes?: number;
    /** Default 10 minutes. Rotate when a worker has been alive this long. */
    rotateAfterMillis?: number;
    /** Optional JSON-RPC notification listener (events have no `id`). */
    onEvent?: (notification: unknown) => void;
    /** Where to send stderr from the helper. Default 'inherit'. */
    stderr?: "inherit" | "ignore" | "pipe";
}

export interface CyclerStats {
    /** Number of times the helper has been respawned (0 = original). */
    rotations: number;
    /** Files uploaded since the current helper started. */
    filesThisCycle: number;
    /** Bytes uploaded since the current helper started. */
    bytesThisCycle: number;
    /** Total files uploaded across all cycles. */
    totalFiles: number;
    /** Total bytes uploaded across all cycles. */
    totalBytes: number;
}

interface PendingCall {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    method: string;
}

const DEFAULT_FILES = 100;
const DEFAULT_BYTES = 500 * 1024 * 1024;
const DEFAULT_MILLIS = 10 * 60_000;

export class HelperCycler {
    private proc: ChildProcess | undefined;
    private buffer = "";
    private pending = new Map<number, PendingCall>();
    private nextId = 1;

    // Session + collection state survives rotation — we re-push it.
    private session: SessionBundle | undefined;
    private collections = new Map<number, unknown>();

    // Per-cycle counters; reset on every rotate().
    private filesThisCycle = 0;
    private bytesThisCycle = 0;
    private cycleStart = 0;

    // Lifetime stats.
    private rotations = 0;
    private totalFiles = 0;
    private totalBytes = 0;

    private readonly rotateAfterFiles: number;
    private readonly rotateAfterBytes: number;
    private readonly rotateAfterMillis: number;

    constructor(private readonly opts: CyclerOptions) {
        this.rotateAfterFiles = opts.rotateAfterFiles ?? DEFAULT_FILES;
        this.rotateAfterBytes = opts.rotateAfterBytes ?? DEFAULT_BYTES;
        this.rotateAfterMillis = opts.rotateAfterMillis ?? DEFAULT_MILLIS;
    }

    /** Spawn the first helper. Idempotent — second call is a no-op. */
    async start(): Promise<void> {
        if (this.proc) return;
        this.spawnProc();
        // Sanity round-trip; also forces the helper through its init path
        // before we hand it real RPCs.
        await this.call("ping", undefined);
    }

    /**
     * SRP login. Stashes the session bundle so future rotations can replay
     * via auth.restore instead of paying for another SRP handshake.
     */
    async login(email: string, password: string): Promise<SessionBundle> {
        await this.start();
        const res = (await this.call("auth.login", { email, password })) as {
            session?: SessionBundle;
        };
        if (!res.session) {
            throw new Error(
                "HelperCycler.login: helper returned no session bundle " +
                    "(rebuild helper from a tree that includes auth.login " +
                    "→ session changes)",
            );
        }
        this.session = res.session;
        return res.session;
    }

    /**
     * Create an album. The full Collection object is stashed so rotations
     * can replay via collections.restore.
     */
    async createCollection(name: string): Promise<{ id: number; name: string }> {
        const res = (await this.call("collections.create", { name })) as {
            id: number;
            name: string;
            collection?: unknown;
        };
        if (!res.collection) {
            throw new Error(
                "HelperCycler.createCollection: helper returned no full " +
                    "collection (rebuild helper from a tree that includes " +
                    "collections.create → collection changes)",
            );
        }
        this.collections.set(res.id, res.collection);
        return { id: res.id, name: res.name };
    }

    /**
     * Upload one file through the helper, rotating beforehand if any
     * limit has been crossed. `sizeBytes` should be the on-disk size —
     * used for the byte-budget check; if you don't have it, pass 0 and
     * only file-count + age rotation will apply.
     */
    async putFile(
        path: string,
        collectionID: number,
        sizeBytes: number,
    ): Promise<unknown> {
        await this.maybeRotate(sizeBytes);
        const result = await this.call("upload.put_file", {
            path,
            collectionID,
        });
        this.filesThisCycle += 1;
        this.bytesThisCycle += sizeBytes;
        this.totalFiles += 1;
        this.totalBytes += sizeBytes;
        return result;
    }

    /**
     * Forward an arbitrary RPC. Useful for methods the cycler doesn't
     * model (auth.whoami, future list/share/etc). Does NOT advance
     * rotation counters — uploads do that.
     */
    async call<T = unknown>(method: string, params: unknown): Promise<T> {
        if (!this.proc) {
            throw new Error("HelperCycler.call: helper not started");
        }
        const id = this.nextId++;
        const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve as (v: unknown) => void,
                reject,
                method,
            });
            this.proc!.stdin!.write(line + "\n", (err) => {
                if (err) {
                    this.pending.delete(id);
                    reject(err);
                }
            });
        });
    }

    /** Force a rotation right now, regardless of limits. */
    async rotate(): Promise<void> {
        await this.rotateNow();
    }

    /** Kill the helper. Safe to call multiple times. */
    async stop(): Promise<void> {
        if (!this.proc) return;
        const proc = this.proc;
        this.proc = undefined;
        // Reject any in-flight calls — they won't get a response now.
        for (const [, p] of this.pending) {
            p.reject(new Error("HelperCycler.stop: helper killed in flight"));
        }
        this.pending.clear();
        return new Promise<void>((resolve) => {
            const done = () => resolve();
            proc.once("exit", done);
            proc.stdin?.end();
            // Belt-and-braces: SIGTERM if it doesn't exit on its own.
            const t = setTimeout(() => proc.kill("SIGTERM"), 500);
            proc.once("exit", () => clearTimeout(t));
        });
    }

    stats(): CyclerStats {
        return {
            rotations: this.rotations,
            filesThisCycle: this.filesThisCycle,
            bytesThisCycle: this.bytesThisCycle,
            totalFiles: this.totalFiles,
            totalBytes: this.totalBytes,
        };
    }

    // ---------- internals ----------

    private shouldRotate(nextSize: number): boolean {
        if (!this.proc) return true; // not started yet
        if (this.filesThisCycle >= this.rotateAfterFiles) return true;
        // Byte check guards against the "many small files" case being fine
        // but "one huge file" forcing a rotation on an empty helper —
        // there's nothing to rotate yet, so wait until at least one upload
        // has landed.
        if (
            this.filesThisCycle > 0 &&
            this.bytesThisCycle + nextSize > this.rotateAfterBytes
        ) {
            return true;
        }
        if (Date.now() - this.cycleStart > this.rotateAfterMillis) return true;
        return false;
    }

    private async maybeRotate(nextSize: number): Promise<void> {
        if (!this.shouldRotate(nextSize)) return;
        if (this.proc) {
            // Genuine rotation, not first-spawn.
            await this.rotateNow();
        } else {
            await this.start();
        }
    }

    private async rotateNow(): Promise<void> {
        this.rotations += 1;
        await this.stop();
        this.spawnProc();
        await this.call("ping", undefined);
        if (this.session) {
            await this.call("auth.restore", this.session);
        }
        for (const collection of this.collections.values()) {
            await this.call("collections.restore", { collection });
        }
        this.filesThisCycle = 0;
        this.bytesThisCycle = 0;
        // cycleStart already updated by spawnProc.
    }

    private spawnProc(): void {
        const stderr = this.opts.stderr ?? "inherit";
        const proc = spawn(this.opts.command, this.opts.args ?? [], {
            cwd: this.opts.cwd,
            stdio: ["pipe", "pipe", stderr],
        });
        proc.on("exit", (code, signal) => {
            // If we still think this proc is current, surface the
            // unexpected death by rejecting all pending RPCs.
            if (this.proc === proc) {
                this.proc = undefined;
                const reason = new Error(
                    `helper exited unexpectedly (code=${code} signal=${signal})`,
                );
                for (const [, p] of this.pending) p.reject(reason);
                this.pending.clear();
            }
        });
        proc.stdout!.setEncoding("utf8");
        proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
        this.proc = proc;
        this.cycleStart = Date.now();
    }

    private onStdout(chunk: string): void {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) continue;
            this.routeLine(line);
        }
    }

    private routeLine(line: string): void {
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
            msg = JSON.parse(line) as typeof msg;
        } catch {
            // Helper printed something non-JSON on stdout. Shouldn't
            // happen (logs go to stderr) but don't crash the pool.
            this.opts.onEvent?.({ malformed: line });
            return;
        }
        if (typeof msg.id !== "number") {
            // Notification (no id) — push to listener.
            this.opts.onEvent?.(msg);
            return;
        }
        const p = this.pending.get(msg.id);
        if (!p) {
            // Late response after timeout/abandon. Drop quietly.
            return;
        }
        this.pending.delete(msg.id);
        if (msg.error) {
            p.reject(
                new Error(
                    `RPC ${p.method} failed: ${JSON.stringify(msg.error)}`,
                ),
            );
        } else {
            p.resolve(msg.result);
        }
    }
}
