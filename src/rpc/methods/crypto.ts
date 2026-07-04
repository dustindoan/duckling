// crypto.* RPC methods.
//
// These exist to canary the sibling-workspace strategy: they call directly
// into ente's libsodium.ts (via tsconfig path alias) and bypass the
// CryptoWorker indirection (which is a thin facade — see CLAUDE.md).
//
// If these methods work end-to-end through the compiled binary, the path
// alias + npm-dep + bun-compile pipeline is proven for arbitrary ente
// imports.

import {
    decryptBoxBytes,
    encryptBox,
    fromB64,
    generateKey,
    toB64,
} from "ente-base/crypto/libsodium";
import type { Dispatcher } from "../dispatch.ts";

interface ToB64Params {
    bytes: number[]; // JSON has no Uint8Array; pass as a number[]
}

interface FromB64Params {
    b64: string;
}

interface RoundTripParams {
    plaintext: string; // utf-8 string for ergonomics; encoded server-side
}

export const registerCryptoMethods = (d: Dispatcher): void => {
    d.register("crypto.toB64", async (params) => {
        const { bytes } = params as ToB64Params;
        if (!Array.isArray(bytes)) {
            throw new Error("crypto.toB64: params.bytes must be a number[]");
        }
        const out = await toB64(new Uint8Array(bytes));
        return { b64: out };
    });

    d.register("crypto.fromB64", async (params) => {
        const { b64 } = params as FromB64Params;
        if (typeof b64 !== "string") {
            throw new Error("crypto.fromB64: params.b64 must be a string");
        }
        const bytes = await fromB64(b64);
        return { bytes: Array.from(bytes) };
    });

    // Roundtrip canary: generates a key, encrypts a UTF-8 string with the
    // secretbox primitive, decrypts it. Proves randombytes, encryption, and
    // decryption all work end-to-end inside the compiled binary.
    d.register("crypto.boxRoundTrip", async (params) => {
        const { plaintext } = params as RoundTripParams;
        if (typeof plaintext !== "string") {
            throw new Error(
                "crypto.boxRoundTrip: params.plaintext must be a string",
            );
        }
        const keyB64 = await generateKey();
        const enc = await encryptBox(
            new TextEncoder().encode(plaintext),
            keyB64,
        );
        const decBytes = await decryptBoxBytes(enc, keyB64);
        const decoded = new TextDecoder().decode(decBytes);
        return {
            keyB64,
            nonce: enc.nonce,
            ciphertextB64: enc.encryptedData,
            roundtrip: decoded,
            ok: decoded === plaintext,
        };
    });
};
