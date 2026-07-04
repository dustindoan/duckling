// cli.ts — human-facing verbs over the RPC dispatcher.
//
// One engine, two transports (see index.ts): every verb here calls the same
// dispatcher the stdio JSON-RPC server exposes. What the verbs add is
// session persistence: ente's localStorage/sessionStorage polyfills are
// in-memory and die with the process, so `login` writes the SessionBundle
// to <state dir>/session.json (mode 0600 — it contains key material) and
// every authenticated verb replays it through auth.restore first. Same
// trick the worker-pool cycler uses across helper rotations.
//
// Output discipline: results to stdout, prompts/diagnostics to stderr, so
// `duckling ls | grep …` works. Callers in index.ts reroute console.log to
// stderr before invoking a verb (ente's info-level logging uses it).

import {
    existsSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { stateDir } from "./platform/sqlite-kv.ts";
import type { Dispatcher } from "./rpc/dispatch.ts";

const out = (s: string): void => void process.stdout.write(s + "\n");
const err = (s: string): void => void process.stderr.write(s + "\n");

const sessionPath = (): string => join(stateDir(), "session.json");

/** Call one RPC method; throw a plain Error on an RPC-level error. */
const rpc = async <T>(
    d: Dispatcher,
    method: string,
    params?: unknown,
): Promise<T> => {
    const res = await d.handle({ jsonrpc: "2.0", id: 1, method, params });
    if ("error" in res) throw new Error(res.error.message);
    return res.result as T;
};

// ---------------------------------------------------------------------------
// Terminal input
// ---------------------------------------------------------------------------

// A single shared line reader. Consecutive prompts must share one readline
// interface: a second createInterface never sees input the first one already
// buffered (with piped stdin that means the second prompt hangs until the
// event loop drains and the process exits 0 mid-flow — the failure we hit).
// Lines that arrive before anyone asks queue up; EOF resolves pending reads
// with "" so callers fail their own validation instead of hanging.
let sharedLines: { queue: string[]; waiters: ((s: string) => void)[] } | null =
    null;
const nextStdinLine = (): Promise<string> => {
    if (!sharedLines) {
        const state = {
            queue: [] as string[],
            waiters: [] as ((s: string) => void)[],
        };
        sharedLines = state;
        const rl = createInterface({ input: process.stdin });
        rl.on("line", (line) => {
            const w = state.waiters.shift();
            if (w) w(line);
            else state.queue.push(line);
        });
        rl.on("close", () => {
            for (const w of state.waiters.splice(0)) w("");
        });
    }
    const state = sharedLines;
    if (state.queue.length > 0)
        return Promise.resolve(state.queue.shift() as string);
    return new Promise((res) => state.waiters.push(res));
};

const readLine = async (label: string): Promise<string> => {
    process.stderr.write(label);
    return (await nextStdinLine()).trim();
};

/**
 * Read a line with echo off (password entry). Raw-mode byte loop on a real
 * terminal; falls back to a plain (visible-input-irrelevant) line read when
 * stdin is piped. Handles backspace, Ctrl-C, and EOF. ASCII-safe; multibyte
 * input works as long as the user doesn't backspace mid-character
 * (acceptable for passwords).
 */
const readSecret = (label: string): Promise<string> => {
    if (!process.stdin.isTTY) return readLine(label);
    return new Promise((resolveSecret) => {
        process.stderr.write(label);
        const stdin = process.stdin;
        const hadRaw = stdin.isRaw ?? false;
        stdin.setRawMode?.(true);
        stdin.resume();
        const bytes: number[] = [];
        const finish = (): void => {
            cleanup();
            process.stderr.write("\n");
            resolveSecret(new TextDecoder().decode(new Uint8Array(bytes)));
        };
        const cleanup = (): void => {
            stdin.off("data", onData);
            stdin.off("end", finish);
            stdin.setRawMode?.(hadRaw);
            stdin.pause();
        };
        const onData = (chunk: Buffer): void => {
            for (const byte of chunk) {
                if (byte === 3) {
                    // Ctrl-C
                    cleanup();
                    process.stderr.write("\n");
                    process.exit(130);
                } else if (byte === 13 || byte === 10) {
                    finish();
                    return;
                } else if (byte === 127 || byte === 8) {
                    bytes.pop();
                } else {
                    bytes.push(byte);
                }
            }
        };
        stdin.on("data", onData);
        stdin.once("end", finish);
    });
};

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

/** Replay the stored session into this process, or exit with guidance. */
const ensureSession = async (d: Dispatcher): Promise<void> => {
    const p = sessionPath();
    if (!existsSync(p)) {
        err("not logged in — run: duckling login");
        process.exit(1);
    }
    let bundle: unknown;
    try {
        bundle = JSON.parse(readFileSync(p, "utf8"));
    } catch {
        err(`could not parse ${p} — run: duckling login`);
        process.exit(1);
    }
    try {
        await rpc(d, "auth.restore", bundle);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err(`stored session rejected (${msg}) — run: duckling login`);
        process.exit(1);
    }
};

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

interface WhoamiResult {
    email?: string;
    usage?: number;
    fileCount?: number;
}

export const cliLogin = async (
    d: Dispatcher,
    argv: string[],
): Promise<void> => {
    let email = argv.find((a) => !a.startsWith("-"));
    if (!email) email = await readLine("email: ");
    if (!email) {
        err("login: email required");
        process.exit(2);
    }
    const password = await readSecret("password: ");
    if (!password) {
        err("login: empty password");
        process.exit(2);
    }

    const result = await rpc<{
        needs_2fa?: string;
        session?: unknown;
    }>(d, "auth.login", { email, password });

    if (result.needs_2fa) {
        err(
            `this account has ${result.needs_2fa} second-factor enabled; ` +
                "duckling login does not support it yet",
        );
        process.exit(1);
    }
    if (!result.session) {
        err("login: museum returned no session (unexpected response shape)");
        process.exit(1);
    }

    writeFileSync(sessionPath(), JSON.stringify(result.session), {
        mode: 0o600,
    });

    const who = await rpc<WhoamiResult>(d, "auth.whoami");
    out(`logged in as ${who.email ?? email}`);
    if (typeof who.fileCount === "number")
        out(`${who.fileCount} files, ${formatBytes(who.usage)} in ente`);
    process.exit(0);
};

export const cliLogout = (): void => {
    const p = sessionPath();
    const hadSession = existsSync(p);
    rmSync(p, { force: true });
    // state.db holds only auth-derived keys; clearing it makes logout total.
    rmSync(join(stateDir(), "state.db"), { force: true });
    out(hadSession ? "logged out" : "no stored session; state cleared anyway");
};

export const cliWhoami = async (d: Dispatcher): Promise<void> => {
    await ensureSession(d);
    const who = await rpc<WhoamiResult>(d, "auth.whoami");
    out(`${who.email ?? "(unknown email)"}`);
    if (typeof who.fileCount === "number")
        out(`${who.fileCount} files, ${formatBytes(who.usage)}`);
    process.exit(0);
};

interface CollectionSummary {
    id: number;
    name: string;
    type: string;
}

export const cliLs = async (d: Dispatcher): Promise<void> => {
    await ensureSession(d);
    const { collections } = await rpc<{ collections: CollectionSummary[] }>(
        d,
        "collections.list",
    );
    const sorted = [...collections].sort((a, b) =>
        a.name.localeCompare(b.name),
    );
    const idWidth = Math.max(...sorted.map((c) => String(c.id).length), 2);
    const typeWidth = Math.max(...sorted.map((c) => c.type.length), 4);
    for (const c of sorted) {
        out(
            `${String(c.id).padStart(idWidth)}  ${c.type.padEnd(typeWidth)}  ${c.name}`,
        );
    }
    err(`${sorted.length} collection(s)`);
    process.exit(0);
};

export const cliUpload = async (
    d: Dispatcher,
    argv: string[],
): Promise<void> => {
    const paths: string[] = [];
    let album: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--album") {
            album = argv[++i];
        } else if (a.startsWith("--album=")) {
            album = a.slice("--album=".length);
        } else if (a.startsWith("-")) {
            err(`upload: unknown flag ${a}`);
            process.exit(2);
        } else {
            paths.push(a);
        }
    }
    if (!album || paths.length === 0) {
        err("usage: duckling upload <file-or-dir>... --album <name>");
        process.exit(2);
    }

    const files: string[] = [];
    const skippedUnsupported: string[] = [];
    const collect = (p: string): void => {
        const abs = resolve(p);
        if (!existsSync(abs)) {
            err(`upload: no such path: ${p}`);
            process.exit(2);
        }
        const st = statSync(abs);
        if (st.isDirectory()) {
            for (const entry of readdirSync(abs).sort()) {
                if (entry.startsWith(".")) continue;
                collect(join(abs, entry));
            }
        } else if (abs.toLowerCase().endsWith(".aae")) {
            // Photos.app edit sidecars — ente has no type for them and the
            // museum rejects them; skip up front instead of failing late.
            skippedUnsupported.push(abs);
        } else {
            files.push(abs);
        }
    };
    for (const p of paths) collect(p);
    if (files.length === 0) {
        err("upload: nothing to upload");
        process.exit(2);
    }

    await ensureSession(d);

    // Resolve the album by exact name; create it if absent. `folder` type
    // collections behave as album aliases (mobile-created), so accept both.
    const { collections } = await rpc<{ collections: CollectionSummary[] }>(
        d,
        "collections.list",
    );
    const match = collections.find(
        (c) => c.name === album && (c.type === "album" || c.type === "folder"),
    );
    let collectionID: number;
    if (match) {
        collectionID = match.id;
        err(`album "${album}" (id ${collectionID})`);
    } else {
        const created = await rpc<{ id: number }>(d, "collections.create", {
            name: album,
        });
        collectionID = created.id;
        err(`album "${album}" created (id ${collectionID})`);
    }

    let uploaded = 0;
    let present = 0;
    let failed = 0;
    for (const [i, path] of files.entries()) {
        const name = basename(path);
        const tag = `[${i + 1}/${files.length}]`;
        try {
            const result = await rpc<{ type?: string }>(d, "upload.put_file", {
                path,
                collectionID,
            });
            const type = result.type ?? "unknown";
            if (type === "alreadyUploaded") {
                present++;
                out(`${tag} = ${name} (already in ente)`);
            } else if (type.startsWith("upload")) {
                uploaded++;
                out(`${tag} ✓ ${name}`);
            } else {
                failed++;
                out(`${tag} ✗ ${name} (${type})`);
            }
        } catch (e) {
            failed++;
            const msg = e instanceof Error ? e.message : String(e);
            out(`${tag} ✗ ${name}: ${msg}`);
        }
    }

    const parts = [`${uploaded} uploaded`, `${present} already present`];
    if (skippedUnsupported.length > 0)
        parts.push(`${skippedUnsupported.length} skipped (.aae)`);
    if (failed > 0) parts.push(`${failed} failed`);
    out(`done: ${parts.join(", ")}`);
    process.exit(failed > 0 ? 1 : 0);
};

const formatBytes = (n?: number): string => {
    if (typeof n !== "number") return "unknown size";
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
    return `${Math.round(n / 1e3)} KB`;
};
