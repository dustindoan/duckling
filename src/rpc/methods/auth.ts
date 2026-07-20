// auth.* RPC methods.
//
// Mirrors the AuthFlowUi shape from ente's Rust CLI: the helper drives a
// state machine and emits events when it needs input (email OTP, TOTP code,
// 2FA choice). The consumer (Swift app or CLI) submits via follow-up RPCs.
//
// This first cut handles the SRP-with-password path against a self-hosted
// museum. Branches we don't yet handle:
//   - First-login email OTP flow (no SRP set up yet)
//   - 2FA / TOTP (returned as `twoFactorSessionID`; consumer must call
//     auth.verify_totp — TODO)
//   - Passkey (returned as `passkeySessionID`; opens an external URL flow)
//
// On success the response includes the auth token (plaintext if the user
// has no key attributes set, or encrypted otherwise; decrypt-after-master-
// password derivation happens in the upload flow, not here).

// Import deriveKey from libsodium.ts directly, not from ente-base/crypto
// (the index). The index dispatches to a Web Worker via
// `new Worker(new URL("worker.ts", import.meta.url))` which Bun does spawn,
// but resolving worker.ts through our symlinked node_modules/ente-base
// doesn't find the file — the call hangs. Bypassing the worker matches our
// audit decision: CryptoWorker is a thin facade over libsodium.ts. Same
// async signature; no behavior change beyond losing the thread isolation
// (which the helper doesn't need — there's no UI to keep responsive).
import {
    boxSealOpenBytes,
    decryptBox,
    deriveKey,
    toB64URLSafe,
} from "ente-base/crypto/libsodium";
import { apiURL } from "ente-base/origins";
import { saveMasterKeyInSessionAndSafeStore } from "ente-base/session";
import { saveAuthToken } from "ente-base/token";
import {
    saveKeyAttributes,
    updateSavedLocalUser,
} from "ente-accounts/services/accounts-db";
import {
    getSRPAttributes,
    srpVerificationUnauthorizedErrorMessage,
    verifySRP,
} from "ente-accounts/services/srp";
import { verifyTwoFactor } from "ente-accounts/services/user";
import { currentAdapter } from "../../platform/install.ts";
import type { Dispatcher } from "../dispatch.ts";

interface LoginParams {
    email: string;
    password: string;
}

/**
 * The post-SRP session state. Everything in here is what a fresh helper
 * needs to behave as if it just finished `auth.login` — no SRP round trip,
 * no password derivation. The worker-pool cycler stashes this after the
 * first login and replays it on every restart via `auth.restore`.
 *
 * `keyAttributes` carries the user's encrypted-key bundle as the museum
 * returned it; ente's saveKeyAttributes treats it as opaque.
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

/**
 * Apply a SessionBundle to the current process: write to adapter.kv (so the
 * helper's own RPCs see the session) and run ente's four hydration calls
 * (so ente's upload/collection code sees it too). Idempotent within a
 * process — calling twice with the same bundle is safe.
 */
const hydrateSession = async (bundle: SessionBundle): Promise<void> => {
    const log = currentAdapter().log;
    const adapter = currentAdapter();

    log.info(`hydrateSession: ${bundle.email} (id ${bundle.id})`);

    await adapter.kv.set("auth.userID", bundle.id);
    await adapter.kv.set("auth.token", bundle.token);
    await adapter.kv.set("auth.masterKey", bundle.masterKeyB64);
    await adapter.kv.set("auth.publicKey", bundle.publicKey);
    await adapter.kv.set("auth.privateKey", bundle.privateKey);

    // Mirrors the four steps at the end of auth.login. These populate
    // localStorage + sessionStorage so ente's upload + collection code
    // finds the session it expects. Lives in-process only; restart wipes
    // them, which is why auth.restore replays them.
    updateSavedLocalUser({
        id: bundle.id,
        email: bundle.email,
        token: bundle.token,
    });
    saveKeyAttributes(bundle.keyAttributes as never);
    await saveMasterKeyInSessionAndSafeStore(bundle.masterKeyB64);
    await saveAuthToken(bundle.token);

    log.info("hydrateSession: complete");
};

/**
 * Recover the bearer token from an encrypted verification response, build the
 * SessionBundle, and hydrate it. Shared by the two ways a login can succeed:
 * SRP-with-password (auth.login) and TOTP second factor (auth.verify_totp).
 * Both hand back the same { id, keyAttributes, encryptedToken } and both
 * decrypt it with the same password-derived kek — only how the response is
 * obtained differs. Mirrors ente/web/packages/accounts/services/user.ts's
 * decryptAndStoreTokenIfNeeded (three-layer decryption).
 */
const completeLogin = async (
    email: string,
    kek: string,
    v: { id: number; encryptedToken?: string; keyAttributes?: unknown },
): Promise<SessionBundle> => {
    const log = currentAdapter().log;

    if (!v.encryptedToken || !v.keyAttributes) {
        throw new Error(
            "verification returned no encryptedToken/keyAttributes",
        );
    }

    const ka = v.keyAttributes as {
        encryptedKey: string;
        keyDecryptionNonce: string;
        encryptedSecretKey: string;
        secretKeyDecryptionNonce: string;
        publicKey: string;
    };

    log.info("completeLogin: decrypting masterKey (encryptedKey → kek)");
    const masterKey = await decryptBox(
        { encryptedData: ka.encryptedKey, nonce: ka.keyDecryptionNonce },
        kek,
    );

    log.info(
        "completeLogin: decrypting privateKey (encryptedSecretKey → masterKey)",
    );
    const privateKey = await decryptBox(
        {
            encryptedData: ka.encryptedSecretKey,
            nonce: ka.secretKeyDecryptionNonce,
        },
        masterKey,
    );

    log.info("completeLogin: opening sealed box (encryptedToken → keypair)");
    const tokenBytes = await boxSealOpenBytes(v.encryptedToken, {
        publicKey: ka.publicKey,
        privateKey,
    });
    const token = await toB64URLSafe(tokenBytes);
    log.info(`completeLogin: token decrypted (${token.length} chars)`);

    const bundle: SessionBundle = {
        id: v.id,
        email,
        token,
        masterKeyB64: masterKey,
        publicKey: ka.publicKey,
        privateKey,
        keyAttributes: v.keyAttributes,
    };

    // Persist to adapter.kv + hydrate ente's localStorage/sessionStorage
    // polyfills so upload + collection code finds the session. See
    // hydrateSession above for the breakdown.
    await hydrateSession(bundle);
    return bundle;
};

export const registerAuthMethods = (d: Dispatcher): void => {
    d.register("auth.whoami", async () => {
        const log = currentAdapter().log;
        const adapter = currentAdapter();
        const token = await adapter.kv.getString("auth.token");
        if (!token) {
            throw new Error("not logged in (no auth.token in KV)");
        }
        const url = await apiURL("/users/details/v2");
        log.info(`auth.whoami: GET ${url}`);
        const res = await fetch(url, {
            headers: {
                "X-Auth-Token": token,
                "X-Client-Package": "io.ente.photos.web",
            },
        });
        log.info(`auth.whoami: HTTP ${res.status}`);
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`whoami failed: ${res.status} ${text.slice(0, 200)}`);
        }
        const body = (await res.json()) as {
            email?: string;
            usage?: number;
            fileCount?: number;
        };
        return {
            ok: true,
            email: body.email,
            usage: body.usage,
            fileCount: body.fileCount,
        };
    });

    d.register("auth.login", async (params) => {
        const log = currentAdapter().log;
        log.info("auth.login: entered handler");

        const { email, password } = params as LoginParams;
        if (typeof email !== "string" || typeof password !== "string") {
            throw new Error(
                "auth.login: params must be { email, password } strings",
            );
        }

        log.info(`auth.login: getSRPAttributes(${email})`);
        const srpAttributes = await getSRPAttributes(email);
        log.info(
            `auth.login: getSRPAttributes returned ${srpAttributes ? "attributes" : "undefined"}`,
        );
        if (!srpAttributes) {
            throw new Error(
                `auth.login: no SRP attributes for ${email} — account not registered, or has not set up SRP`,
            );
        }

        log.info(
            `auth.login: deriveKey opsLimit=${srpAttributes.opsLimit} memLimit=${srpAttributes.memLimit}`,
        );
        const kek = await deriveKey(
            password,
            srpAttributes.kekSalt,
            srpAttributes.opsLimit,
            srpAttributes.memLimit,
        );
        log.info("auth.login: deriveKey done");

        // Delegate to ente's verifySRP. Previously inlined (with per-step
        // logging) because process.env.appName wasn't set early enough —
        // the X-Client-Package header came out `undefined` and museum POSTs
        // hung. src/platform/env.ts now populates appName before any ente
        // import, so publicRequestHeaders() inside verifySRP yields the
        // right header on its own and the canonical implementation works.
        log.info("auth.login: verifySRP");
        let verification: Awaited<ReturnType<typeof verifySRP>>;
        try {
            verification = await verifySRP(srpAttributes, kek);
        } catch (err) {
            // ente throws an Error whose message is exactly
            // srpVerificationUnauthorizedErrorMessage on HTTP 401. Surface
            // that as our previous "incorrect password" message so the
            // existing client UX stays stable.
            if (
                err instanceof Error &&
                err.message === srpVerificationUnauthorizedErrorMessage
            ) {
                throw new Error("incorrect password (SRP verification failed)");
            }
            throw err;
        }
        log.info("auth.login: verifySRP complete");

        if (verification.twoFactorSessionID || verification.passkeySessionID) {
            // Don't try to decrypt — there's no usable token yet.
            return {
                id: verification.id,
                needs_2fa: verification.passkeySessionID ? "passkey" : "totp",
                twoFactorSessionID: verification.twoFactorSessionID,
                twoFactorSessionIDV2: verification.twoFactorSessionIDV2,
                passkeySessionID: verification.passkeySessionID,
                kekB64: kek,
            };
        }

        // No 2FA challenge: verifySRP already returned the encrypted token +
        // key attributes. completeLogin decrypts them with the kek and
        // hydrates the session (same path the TOTP flow rejoins).
        const bundle = await completeLogin(email, kek, verification);

        return {
            // Legacy shape callers (probe-upload, probe-login) read these
            // top-level fields; keep them for compatibility.
            id: bundle.id,
            userID: bundle.id,
            token: bundle.token,
            masterKeyB64: bundle.masterKeyB64,
            // Worker-pool reads `session` whole and replays via auth.restore.
            session: bundle,
        };
    });

    // Rehydrate the post-SRP state from a SessionBundle. Used by the
    // worker-pool cycler to bring a freshly-spawned helper up to "logged in"
    // without paying for another SRP round trip.
    d.register("auth.restore", async (params) => {
        const bundle = params as SessionBundle | undefined;
        if (!bundle || typeof bundle.token !== "string" ||
            typeof bundle.masterKeyB64 !== "string" ||
            typeof bundle.email !== "string" ||
            typeof bundle.id !== "number" ||
            typeof bundle.publicKey !== "string" ||
            typeof bundle.privateKey !== "string" ||
            !bundle.keyAttributes) {
            throw new Error(
                "auth.restore: params must be a SessionBundle " +
                    "{ id, email, token, masterKeyB64, publicKey, privateKey, keyAttributes }",
            );
        }
        await hydrateSession(bundle);
        return { ok: true, id: bundle.id };
    });

    // Second half of a 2FA login. When SRP verification returns a TOTP
    // challenge, auth.login hands back needs_2fa:"totp" with a
    // twoFactorSessionID and the password-derived kek (kekB64) instead of a
    // session; the consumer collects the 6-digit code and submits it here.
    // ente's verifyTwoFactor exchanges (code, sessionID) for the same
    // { id, keyAttributes, encryptedToken } an SRP success yields, which
    // completeLogin then decrypts with that kek — so a 2FA login converges on
    // the exact same SessionBundle as a password-only one.
    d.register("auth.verify_totp", async (params) => {
        const log = currentAdapter().log;
        const { email, sessionID, code, kekB64 } = (params ?? {}) as {
            email?: string;
            sessionID?: string;
            code?: string;
            kekB64?: string;
        };
        if (!email || !sessionID || !code || !kekB64) {
            throw new Error(
                "auth.verify_totp: params must be " +
                    "{ email, sessionID, code, kekB64 } strings",
            );
        }

        log.info("auth.verify_totp: verifyTwoFactor");
        let resp: Awaited<ReturnType<typeof verifyTwoFactor>>;
        try {
            resp = await verifyTwoFactor(code.replace(/\s+/g, ""), sessionID);
        } catch (err) {
            // The museum answers a wrong or expired code with HTTP 401, which
            // ente's ensureOk turns into a throw. Surface a stable message.
            throw new Error(
                "incorrect or expired 2FA code " +
                    `(${err instanceof Error ? err.message : String(err)})`,
            );
        }
        log.info("auth.verify_totp: verifyTwoFactor accepted");

        const bundle = await completeLogin(email, kekB64, resp);
        return {
            id: bundle.id,
            userID: bundle.id,
            token: bundle.token,
            masterKeyB64: bundle.masterKeyB64,
            session: bundle,
        };
    });
};
