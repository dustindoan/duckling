// Standalone canary for fast-srp-hap under Bun.
//
// Runs the same SRP setup ente's verifySRP does, but with no network and
// no plumbing — just the bits that could be slow or hung:
//
//   1. crypto.randomBytes(32, callback)   ← async callback; could hang
//   2. new SrpClient(params['4096'], ...) ← 4096-bit modexp in jsbn
//   3. srpClient.computeA()               ← just returns cached A
//
// Timestamps each step so we can tell slow-but-working apart from hung.

import { SRP, SrpClient } from "fast-srp-hap";
import crypto from "node:crypto";

const t0 = Date.now();
const log = (msg: string) => console.log(`+${Date.now() - t0}ms ${msg}`);

log("starting");

log("crypto.randomBytes(32) callback form");
crypto.randomBytes(32, (err, clientKey) => {
    if (err) {
        log(`randomBytes errored: ${err}`);
        return;
    }
    log("randomBytes done; constructing SrpClient (4096-bit)");

    const salt = Buffer.from("0".repeat(32), "hex"); // 16 bytes
    const userID = Buffer.from("test-user");
    const password = Buffer.from("password");

    const client = new SrpClient(
        SRP.params["4096"],
        salt,
        userID,
        password,
        clientKey,
        false,
    );
    log("SrpClient constructed");

    const A = client.computeA();
    log(`computeA done; A is ${A.length} bytes`);
});

log("done (sync); waiting for callback");
