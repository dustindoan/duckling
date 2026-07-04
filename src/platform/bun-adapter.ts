// Bun implementation of PlatformAdapter.
//
// Every method here is a stub that throws `NotImplemented`. Filling them in
// is part of the "wire up first ente import" milestone — not this one.
// The point of this file existing today is to keep the type graph closed:
// adapter.ts is the interface, this is the proof an impl can exist.

import type {
    LocalStorageLike,
    Logger,
    PlatformAdapter,
    UploadLedger,
} from "./adapter.ts";
import { BunFFmpegRunner } from "./bun-ffmpeg.ts";
import { BunThumbnailer } from "./bun-thumbnailer.ts";
import { SqliteKV } from "./sqlite-kv.ts";

// Kept around for any future not-yet-wired surface; ffmpeg is no longer
// a NotImplemented case.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
class NotImplemented extends Error {
    constructor(what: string) {
        super(`PlatformAdapter.${what} not implemented yet`);
        this.name = "NotImplemented";
    }
}

// PlatformAdapter.kv backs OUR persisted state (auth token, master key,
// helper-specific bookkeeping). It is SEPARATE from ente-base/kv (the IDB
// store ente's own code uses for its internal state — backed by
// fake-indexeddb at install.ts). Kept disjoint on purpose: when iOS Rust
// happens, the adapter.kv mapping is "implement this in Rust"; ente's IDB
// remains a browser-flavored detail.
//
// Persists to ~/.coralstack-ente-helper/state.db; survives restarts.

// Lightweight in-memory localStorage. Real impl (with optional file
// persistence) follows once we know which keys ente actually reads.
class InMemoryLocalStorage implements LocalStorageLike {
    private store = new Map<string, string>();
    getItem(key: string): string | null {
        return this.store.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.store.set(key, String(value));
    }
    removeItem(key: string): void {
        this.store.delete(key);
    }
    clear(): void {
        this.store.clear();
    }
    get length(): number {
        return this.store.size;
    }
    key(index: number): string | null {
        return [...this.store.keys()][index] ?? null;
    }
}

const todoLedger: UploadLedger = {
    async markUploaded() {
        // No-op is fine: the macOS FileProvider extension owns dedup.
        // Keeping the method on the interface so an iOS impl can choose
        // differently.
    },
    async markZipItemUploaded() {
        // No-op for the same reason.
    },
};

const consoleLogger: Logger = {
    debug: (...args) => console.error("[debug]", ...args),
    info: (...args) => console.error("[info]", ...args),
    warn: (...args) => console.error("[warn]", ...args),
    error: (...args) => console.error("[error]", ...args),
};

export const makeBunAdapter = (): PlatformAdapter => ({
    kv: new SqliteKV(),
    localStorage: new InMemoryLocalStorage(),
    thumbnailer: new BunThumbnailer(),
    ffmpeg: new BunFFmpegRunner(),
    ledger: todoLedger,
    log: consoleLogger,
});
