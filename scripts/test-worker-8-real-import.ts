// Test 8: import generateKey from ente-base/crypto exactly the way
// ente's session.ts does. Construct happens lazily inside the call.

import "../src/platform/env.ts"; // appName, museum URL

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

log("dynamic import of ente-base/crypto");
const { generateKey, encryptBox } = await import("ente-base/crypto");
log("module imported; calling generateKey()");

try {
    const key = await Promise.race([
        generateKey(),
        new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("5s timeout on generateKey")), 5000),
        ),
    ]);
    log(`generateKey returned: ${key.slice(0, 16)}...`);

    log("calling encryptBox()");
    const box = await Promise.race([
        encryptBox("hello", key),
        new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("5s timeout on encryptBox")), 5000),
        ),
    ]);
    log(`encryptBox returned: ${box.encryptedData.slice(0, 16)}...`);
    process.exit(0);
} catch (e) {
    log(`error: ${(e as Error).message}`);
    process.exit(1);
}
