// probe-upload.ts — drives one helper process through:
//   1. auth.login
//   2. collections.create("helper-test-<timestamp>")
//   3. upload.put_file(test_image, collection.id)
//
// Single helper process so the collection cache survives between calls.
// Each request waits for its response before sending the next.
//
// Reads ENTE_EMAIL + ENTE_PASSWORD from env.

import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import sharp from "sharp";

const email = process.env.ENTE_EMAIL;
const password = process.env.ENTE_PASSWORD;
if (!email || !password) {
    console.error("Set ENTE_EMAIL and ENTE_PASSWORD env vars first.");
    process.exit(1);
}

const testImage = "/tmp/coralstack-upload-test.jpg";
if (!existsSync(testImage)) {
    console.error(`Generating test image at ${testImage}`);
    await sharp({
        create: {
            width: 200,
            height: 200,
            channels: 3,
            background: { r: 100, g: 180, b: 220 },
        },
    })
        .jpeg({ quality: 90 })
        .toFile(testImage);
}

// Spawn helper. Use the compiled binary if it exists and HELPER_MODE=binary;
// otherwise fall back to `bun run src/index.ts` for iteration speed.
const helperRoot = `${process.env.HOME}/Dev/personal/coralstack-ente-helper`;
const useBinary = process.env.HELPER_MODE === "binary";
const helper = useBinary
    ? spawn(`${helperRoot}/dist/ente-helper`, [], {
          cwd: helperRoot,
          stdio: ["pipe", "pipe", "inherit"],
      })
    : spawn("bun", ["--preserve-symlinks", "run", "src/index.ts"], {
          cwd: helperRoot,
          stdio: ["pipe", "pipe", "inherit"],
      });
console.error(`helper: ${useBinary ? "compiled binary" : "bun run"}`);

let buffer = "";
const pending = new Map<number, (v: unknown) => void>();

helper.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
            const msg = JSON.parse(line) as { id?: number };
            if (typeof msg.id === "number" && pending.has(msg.id)) {
                pending.get(msg.id)!(msg);
                pending.delete(msg.id);
            } else {
                console.log("event:", line);
            }
        } catch {
            console.log("non-JSON:", line);
        }
    }
});

const send = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    const id = Math.floor(Math.random() * 1e9);
    const req = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise((resolve) => {
        pending.set(id, resolve as (v: unknown) => void);
        helper.stdin.write(JSON.stringify(req) + "\n");
    });
};

try {
    console.error("→ auth.login");
    const login = (await send("auth.login", { email, password })) as {
        result?: { token?: string };
        error?: unknown;
    };
    if (login.error) throw new Error(`login: ${JSON.stringify(login.error)}`);
    console.error(`  token: ${login.result?.token?.slice(0, 16)}...`);

    const albumName = `helper-test-${Date.now()}`;
    console.error(`→ collections.create("${albumName}")`);
    const create = (await send("collections.create", { name: albumName })) as {
        result?: { id?: number };
        error?: unknown;
    };
    if (create.error) throw new Error(`create: ${JSON.stringify(create.error)}`);
    const collectionID = create.result?.id;
    if (!collectionID) throw new Error("no collection ID returned");
    console.error(`  collection ${collectionID}`);

    console.error(`→ upload.put_file(${testImage}, ${collectionID})`);
    const upload = (await send("upload.put_file", {
        path: testImage,
        collectionID,
    })) as { result?: unknown; error?: unknown };
    if (upload.error) {
        console.error(`upload error:`, upload.error);
    } else {
        console.error(`  upload result:`, JSON.stringify(upload.result));
    }
} finally {
    helper.stdin.end();
    helper.kill();
}
