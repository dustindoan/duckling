// cli.ts — human-facing verbs over the RPC dispatcher.
//
// One engine, two transports (see index.ts): every verb here calls the same
// dispatcher the stdio JSON-RPC server exposes — except `drain`, which is
// an orchestrator that does all its RPC through a self-spawned duckling
// child instead (see its section header below). What the verbs add is
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
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DucklingClient } from "./drain-client.ts";
import {
    createDrainer,
    newTotals,
    runWatch,
    type DrainTotals,
} from "./drain.ts";
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
 * Read a single line from a real terminal in raw mode, resolving on Enter.
 * Handles backspace, Ctrl-C, and EOF; ASCII-safe (multibyte works as long as
 * the user doesn't backspace mid-character). Falls back to a plain line read
 * when stdin is piped.
 *
 * Why not readLine for prompts that follow a secret: readLine's shared
 * readline interface (nextStdinLine) stays attached to stdin across a
 * readSecret call and, in raw mode, queues the just-typed line as a phantom.
 * A readLine issued *after* readSecret then returns that stale line
 * immediately instead of waiting — so a "2FA code" prompt after the password
 * would submit the password (or empty) without ever pausing for input.
 * Reading raw bytes here bypasses that queue entirely.
 *
 * `echo` shows typed characters (for non-secret input like a TOTP code) or
 * hides them (for passwords).
 */
const readRaw = (label: string, echo: boolean): Promise<string> => {
    if (!process.stdin.isTTY) return readLine(label);
    return new Promise((resolve) => {
        process.stderr.write(label);
        const stdin = process.stdin;
        const hadRaw = stdin.isRaw ?? false;
        stdin.setRawMode?.(true);
        stdin.resume();
        const bytes: number[] = [];
        const finish = (): void => {
            cleanup();
            process.stderr.write("\n");
            resolve(new TextDecoder().decode(new Uint8Array(bytes)));
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
                    // Backspace: drop a byte, and visually erase if echoing.
                    if (bytes.pop() !== undefined && echo)
                        process.stderr.write("\b \b");
                } else {
                    bytes.push(byte);
                    if (echo) process.stderr.write(String.fromCharCode(byte));
                }
            }
        };
        stdin.on("data", onData);
        stdin.once("end", finish);
    });
};

/** Read a secret (password) with echo off. */
const readSecret = (label: string): Promise<string> => readRaw(label, false);

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

// auth.login returns either a completed `session` or, when a second factor is
// required, `needs_2fa` plus the material auth.verify_totp needs to finish
// (the two-factor session id and the password-derived kek). auth.verify_totp
// returns the same completed shape as a password-only auth.login.
interface LoginResult {
    needs_2fa?: string;
    twoFactorSessionID?: string;
    kekB64?: string;
    session?: unknown;
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

    let result = await rpc<LoginResult>(d, "auth.login", { email, password });

    if (result.needs_2fa === "totp") {
        if (!result.twoFactorSessionID || !result.kekB64) {
            err(
                "login: museum requested a 2FA code but returned no session " +
                    "id (unexpected response shape)",
            );
            process.exit(1);
        }
        // readRaw, not readLine: this prompt follows readSecret (password),
        // and readLine would return a phantom queued line without waiting.
        const code = (await readRaw("2FA code: ", true)).replace(/\s+/g, "");
        if (!code) {
            err("login: empty 2FA code");
            process.exit(2);
        }
        result = await rpc<LoginResult>(d, "auth.verify_totp", {
            email,
            sessionID: result.twoFactorSessionID,
            code,
            kekB64: result.kekB64,
        });
    } else if (result.needs_2fa) {
        // passkey (WebAuthn) needs a browser flow we don't drive yet.
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

/** Resolve an album by exact name, creating it if absent. `folder` type
 * collections behave as album aliases (mobile-created), so accept both.
 * Shared by cliUpload and cliDrain — both need the same "find or create
 * exactly this album" semantics. */
const resolveOrCreateAlbum = async (
    d: Dispatcher,
    name: string,
): Promise<number> => {
    const { collections } = await rpc<{ collections: CollectionSummary[] }>(
        d,
        "collections.list",
    );
    const match = collections.find(
        (c) => c.name === name && (c.type === "album" || c.type === "folder"),
    );
    if (match) {
        err(`album "${name}" (id ${match.id})`);
        return match.id;
    }
    const created = await rpc<{ id: number }>(d, "collections.create", {
        name,
    });
    err(`album "${name}" created (id ${created.id})`);
    return created.id;
};

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

    const collectionID = await resolveOrCreateAlbum(d, album);

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

// ---------------------------------------------------------------------------
// drain — continuous watch over a staging directory (e.g. an FSKit-mounted
// export drive). Folded in from waddle. Unlike every other verb in this
// file, cliDrain never touches the in-process Dispatcher: it does all
// upload work through a DucklingClient that spawns duckling itself as a
// child (see drain-client.ts and drain.ts's file header for why). That
// keeps this orchestrator's own memory flat for the life of the watch —
// only the child's memory is subject to ente's upload-pipeline growth,
// and only the child gets rotated.
// ---------------------------------------------------------------------------

/** Per-upload ceiling before a call is declared wedged. Sized for a
 * multi-GB video over a slow uplink, with margin. Env override exists for
 * integration tests (and emergencies), not for tuning. */
const UPLOAD_TIMEOUT_MS = Number(
    process.env.DUCKLING_UPLOAD_TIMEOUT_MS ?? 45 * 60 * 1000,
);

/** Give up on a staged file after this many failed upload attempts; it
 * stays in staging and is reported at the end. Attempt counts live in
 * this orchestrator and survive child rotations. */
const MAX_ATTEMPTS_PER_FILE = 2;

interface DrainFlags {
    album: string;
    staging: string;
    quiesceSecs: number;
    zeroByteQuiesceSecs: number;
    pairGraceSecs: number;
    pollSecs: number;
    sentinelTtlSecs: number;
    rotateEvery: number;
    once: boolean;
    statusFile: string;
}

const parseDrainFlags = (argv: string[]): DrainFlags => {
    const opts: DrainFlags = {
        album: "",
        staging: join(homedir(), "EnteExportStaging"),
        quiesceSecs: Number(process.env.DUCKLING_QUIESCE_SECS ?? 5),
        zeroByteQuiesceSecs: Number(
            process.env.DUCKLING_ZERO_BYTE_QUIESCE_SECS ?? 600,
        ),
        pairGraceSecs: Number(process.env.DUCKLING_PAIR_GRACE_SECS ?? 15),
        pollSecs: Number(process.env.DUCKLING_POLL_SECS ?? 5),
        sentinelTtlSecs: Number(process.env.DUCKLING_SENTINEL_TTL_SECS ?? 900),
        rotateEvery: 500,
        once: false,
        statusFile: join(stateDir(), "drain-status.json"),
    };
    const takeValue = (flag: string, v: string | undefined): string => {
        if (v === undefined) {
            err(`drain: ${flag} needs a value`);
            process.exit(2);
        }
        return v;
    };
    const takeNumber = (flag: string, v: string | undefined): number => {
        const n = Number(takeValue(flag, v));
        if (!Number.isFinite(n) || n <= 0) {
            err(`drain: ${flag} must be a positive number`);
            process.exit(2);
        }
        return n;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        switch (a) {
            case "--album":
                opts.album = takeValue(a, argv[++i]);
                break;
            case "--staging":
                opts.staging = takeValue(a, argv[++i]);
                break;
            case "--quiesce":
                opts.quiesceSecs = takeNumber(a, argv[++i]);
                break;
            case "--zero-byte-quiesce":
                opts.zeroByteQuiesceSecs = takeNumber(a, argv[++i]);
                break;
            case "--pair-grace":
                opts.pairGraceSecs = takeNumber(a, argv[++i]);
                break;
            case "--sentinel-ttl":
                opts.sentinelTtlSecs = takeNumber(a, argv[++i]);
                break;
            case "--poll":
                opts.pollSecs = takeNumber(a, argv[++i]);
                break;
            case "--rotate-every":
                opts.rotateEvery = takeNumber(a, argv[++i]);
                break;
            case "--status-file":
                opts.statusFile = takeValue(a, argv[++i]);
                break;
            case "--once":
                opts.once = true;
                break;
            default:
                err(`drain: unknown option ${a}`);
                process.exit(2);
        }
    }
    if (!opts.album) {
        err("usage: duckling drain --album <name> [options] (see --help)");
        process.exit(2);
    }
    return opts;
};

const countStagedFiles = (staging: string): number => {
    if (!existsSync(staging)) return 0;
    return readdirSync(staging, { withFileTypes: true }).filter(
        (e) => e.isFile() && !e.name.startsWith("."),
    ).length;
};

/** cliDrain never receives (or needs) the top-level Dispatcher — see the
 * section header. */
export const cliDrain = async (argv: string[]): Promise<void> => {
    const opts = parseDrainFlags(argv);

    if (!existsSync(sessionPath())) {
        err(`not logged in — run: duckling login`);
        process.exit(1);
    }

    mkdirSync(opts.staging, { recursive: true });
    mkdirSync(dirname(opts.statusFile), { recursive: true });
    err(`draining ${opts.staging} ${opts.once ? "(once)" : "(watch)"}`);

    const client = new DucklingClient();
    try {
        await client.start();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err(`drain: could not start duckling worker: ${msg}`);
        process.exit(1);
    }
    const collectionID = await client.ensureAlbum(opts.album);
    err(`album "${opts.album}" → collection ${collectionID}`);

    const totals: DrainTotals = newTotals();
    const drainer = createDrainer({
        client,
        collectionID,
        totals,
        uploadTimeoutMs: UPLOAD_TIMEOUT_MS,
        maxAttemptsPerFile: MAX_ATTEMPTS_PER_FILE,
        rotateEvery: opts.rotateEvery,
    });

    await runWatch(
        {
            staging: opts.staging,
            quiesceSecs: opts.quiesceSecs,
            zeroByteQuiesceSecs: opts.zeroByteQuiesceSecs,
            pairGraceSecs: opts.pairGraceSecs,
            pollSecs: opts.pollSecs,
            sentinelTtlSecs: opts.sentinelTtlSecs,
            once: opts.once,
            statusFile: opts.statusFile,
        },
        { drainer, totals, album: opts.album },
    );

    await client.stop();

    const parts = [
        `${totals.uploaded} uploaded (${totals.livePairs} live photo pairs)`,
        `${totals.present} already present`,
        `${totals.failed} failed`,
        `${totals.skippedUnsupported + totals.skippedAae} skipped (${totals.skippedAae} .aae)`,
    ];
    out(`done: ${parts.join(", ")}`);

    const remaining = countStagedFiles(opts.staging);
    if (remaining > 0) {
        out(`${remaining} file(s) left in staging: ${opts.staging}`);
        process.exit(1);
    }
    process.exit(0);
};

const formatBytes = (n?: number): string => {
    if (typeof n !== "number") return "unknown size";
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
    return `${Math.round(n / 1e3)} KB`;
};
