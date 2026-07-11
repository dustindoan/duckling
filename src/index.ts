// duckling entrypoint — headless ente client.
//
// Runs ente desktop's own upload/auth/crypto code (consumed from the ente
// web workspace) outside Electron, compiled to a single binary via
// `bun build --compile`.
//
// Two modes, selected by argv:
//
//   duckling                          → stdio JSON-RPC server (ndjson)
//   duckling call <method> ['<json>'] → invoke one RPC method, print result
//   duckling --version | --help | --list-methods
//
// Friendlier CLI verbs (`login`, `upload`, …) layer on top of the same
// dispatcher — see Bitwarden's `bw` for the precedent: one engine, two
// transports.

// Side-effect import — MUST be first. Populates process.env before any
// ente module evaluates. See ./platform/env.ts for why.
import "./platform/env.ts";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
    cliLogin,
    cliLogout,
    cliLs,
    cliUpload,
    cliWhoami,
} from "./cli.ts";
import { installPlatformAdapter } from "./platform/install.ts";
import { stateDir } from "./platform/sqlite-kv.ts";
import { makeBunAdapter } from "./platform/bun-adapter.ts";
import { Dispatcher } from "./rpc/dispatch.ts";
import { registerAuthMethods } from "./rpc/methods/auth.ts";
import { registerCollectionMethods } from "./rpc/methods/collections.ts";
import { registerCryptoMethods } from "./rpc/methods/crypto.ts";
import { registerDownloadMethods } from "./rpc/methods/download.ts";
import { registerFileMethods } from "./rpc/methods/files.ts";
import { registerUploadMethods } from "./rpc/methods/upload.ts";
import {
    ErrorCodes,
    type JsonRpcError,
    type JsonRpcRequest,
} from "./rpc/types.ts";

const VERSION = "0.2.0";

const buildDispatcher = (): Dispatcher => {
    const d = new Dispatcher();

    d.register("ping", async () => "pong");
    d.register("version", async () => ({ version: VERSION }));

    // crypto.* — proves the sibling-workspace path-alias strategy works.
    registerCryptoMethods(d);

    // auth.* — SRP login against a self-hosted museum.
    registerAuthMethods(d);

    // collections.* — album create/list.
    registerCollectionMethods(d);

    // upload.* — file upload to museum.
    registerUploadMethods(d);

    // files.* — per-file operations (trash).
    registerFileMethods(d);

    // download.* — fetch + decrypt a file's bytes.
    registerDownloadMethods(d);

    return d;
};

const runStdioServer = async (dispatcher: Dispatcher): Promise<void> => {
    // Stdout is the JSON-RPC response channel — nothing else may write to it.
    // ente's base/log.ts uses console.log/console.info for info-level messages
    // (its !shouldLogToDisk branch), which would otherwise interleave with our
    // ndjson and break strict consumers (e.g. the Swift wrapper). Reroute
    // everything that isn't an explicit process.stdout.write to stderr.
    //
    // CLI modes (--version, --help, --list-methods) handled earlier in main()
    // can still console.log freely — that branch returns before reaching here.
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = (...args: unknown[]) => console.error(...args);

    const decoder = new TextDecoder();
    let buffer = "";

    // @ts-expect-error: Bun exposes ReadableStream on process.stdin
    for await (const chunk of process.stdin) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;
            await handleLine(line, dispatcher);
        }
    }
};

const handleLine = async (
    line: string,
    dispatcher: Dispatcher,
): Promise<void> => {
    let req: JsonRpcRequest;
    try {
        req = JSON.parse(line) as JsonRpcRequest;
    } catch {
        const err: JsonRpcError = {
            jsonrpc: "2.0",
            id: null,
            error: { code: ErrorCodes.ParseError, message: "Invalid JSON" },
        };
        process.stdout.write(JSON.stringify(err) + "\n");
        return;
    }
    const response = await dispatcher.handle(req);
    // JSON-RPC notifications (no id) execute but get no response — writing
    // one anyway would emit an id-less object that strict clients misparse.
    if (req.id === undefined) return;
    process.stdout.write(JSON.stringify(response) + "\n");
};

// One-shot RPC invocation from argv. Events the method emits mid-flight
// (upload.progress etc.) still stream to stdout as ndjson; the final result
// prints pretty. Exits nonzero on RPC error.
const runCallVerb = async (
    dispatcher: Dispatcher,
    argv: string[],
): Promise<void> => {
    const [method, paramsJson] = argv;
    if (!method) {
        console.error("usage: duckling call <method> ['<params-json>']");
        console.error("       duckling --list-methods");
        process.exit(2);
    }
    let params: unknown;
    if (paramsJson !== undefined) {
        try {
            params = JSON.parse(paramsJson);
        } catch {
            console.error("call: <params-json> is not valid JSON");
            process.exit(2);
        }
    }

    // Same stdout discipline as the stdio server: ente's info-level
    // console.log must not interleave with the JSON result.
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = (...args: unknown[]) => console.error(...args);

    // Replay the stored session (if any) so authenticated methods work
    // one-shot, same as the friendly verbs. Skipped for auth.* — login
    // must not be preempted, and restore would be redundant.
    if (!method.startsWith("auth.")) {
        const sessionFile = join(stateDir(), "session.json");
        if (existsSync(sessionFile)) {
            const bundle = JSON.parse(
                readFileSync(sessionFile, "utf8"),
            ) as unknown;
            const restored = await dispatcher.handle({
                jsonrpc: "2.0",
                id: 0,
                method: "auth.restore",
                params: bundle,
            });
            if ("error" in restored)
                console.error(
                    `call: stored session rejected (${restored.error.message}) — continuing unauthenticated`,
                );
        }
    }

    const response = await dispatcher.handle({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
    });
    if ("error" in response) {
        console.error(
            `error ${response.error.code}: ${response.error.message}`,
        );
        if (response.error.data !== undefined)
            console.error(JSON.stringify(response.error.data, null, 2));
        process.exit(1);
    }
    // Await the flush: process.exit() discards whatever hasn't drained
    // through the stdout pipe yet, which silently truncated results at
    // 64 KB (one pipe buffer) — bit us on a 4k-file list_files.
    await new Promise<void>((resolve) => {
        process.stdout.write(
            JSON.stringify(response.result, null, 2) + "\n",
            () => resolve(),
        );
    });
    // Explicit exit: worker-pool children or open handles must not keep a
    // one-shot invocation alive.
    process.exit(0);
};

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);

    const adapter = makeBunAdapter();
    installPlatformAdapter(adapter);
    adapter.log.info(`museum: ${process.env.NEXT_PUBLIC_ENTE_ENDPOINT}`);
    const dispatcher = buildDispatcher();

    if (args.includes("--version")) {
        console.log(VERSION);
        return;
    }
    if (args.includes("--help")) {
        console.log("duckling — headless ente client");
        console.log("");
        console.log("Runs ente desktop's own audited upload + crypto code,");
        console.log("compiled to a single binary. No Electron.");
        console.log("");
        console.log("Usage:");
        console.log("  duckling login [email]             interactive login (SRP; prompts for password)");
        console.log("  duckling whoami                    account, file count, storage used");
        console.log("  duckling ls                        list albums");
        console.log("  duckling upload <path>... --album <name>");
        console.log("                                     upload files/folders into an album");
        console.log("  duckling logout                    forget the stored session");
        console.log("  duckling call <method> ['<json>']  invoke one RPC method, print the result");
        console.log("  duckling --list-methods            print known RPC methods");
        console.log("  duckling                           stdio JSON-RPC server (ndjson in/out)");
        console.log("  duckling --version | --help");
        console.log("");
        console.log("Environment:");
        console.log("  DUCKLING_ENDPOINT     museum API endpoint (default https://api.ente.io)");
        console.log("  DUCKLING_STATE_DIR    session state dir (default ~/.duckling)");
        console.log("  DUCKLING_FFMPEG_PATH  ffmpeg binary (default: sibling of duckling, then PATH)");
        return;
    }
    if (args.includes("--list-methods")) {
        for (const m of dispatcher.knownMethods()) console.log(m);
        return;
    }
    if (args.length > 0) {
        // Human verbs: results on stdout, everything else on stderr. Same
        // console rerouting as the stdio server so ente's info-level
        // console.log can't pollute pipeable output.
        console.log = (...a: unknown[]) => console.error(...a);
        console.info = (...a: unknown[]) => console.error(...a);
        try {
            switch (args[0]) {
                case "call":
                    await runCallVerb(dispatcher, args.slice(1));
                    return;
                case "login":
                    await cliLogin(dispatcher, args.slice(1));
                    return;
                case "logout":
                    cliLogout();
                    return;
                case "whoami":
                    await cliWhoami(dispatcher);
                    return;
                case "ls":
                    await cliLs(dispatcher);
                    return;
                case "upload":
                    await cliUpload(dispatcher, args.slice(1));
                    return;
                default:
                    console.error(
                        `duckling: unknown command "${args[0]}" — see duckling --help`,
                    );
                    process.exit(2);
            }
        } catch (e) {
            // Verb-level failures read as one line, not a stack trace.
            // (Genuine bugs still crash loudly via main().catch below.)
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`duckling ${args[0]}: ${msg}`);
            process.exit(1);
        }
    }

    await runStdioServer(dispatcher);
};

main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error("fatal:", msg);
    process.exit(1);
});
