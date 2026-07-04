// install.ts — bridges PlatformAdapter onto the globals ente's code reads from.
//
// Why this exists: ente's upload code reaches for `globalThis.electron` and
// `window.localStorage` directly. We can't refactor that (it lives in the
// sibling checkout we don't own). Instead, we install a small `electron`-
// shaped object and a `localStorage` polyfill on globalThis, both backed by
// the adapter.
//
// The shim files at src/platform/shims/{electron,kv}.ts are tsconfig-aliased
// in for the *typed* imports. This file handles the *untyped* globalThis
// reads that happen at runtime inside ente's compiled code.

import "fake-indexeddb/auto"; // installs IDB on globalThis as a side effect
import type { LocalStorageLike, PlatformAdapter } from "./adapter.ts";

// In-memory sessionStorage polyfill. ente's base/session.ts uses
// sessionStorage to hold the encrypted master key during a logged-in
// session. Lives only as long as the helper process; cleared on exit.
// Separate instance from localStorage on purpose (matches browser
// semantics where the two are distinct stores).
class InMemorySessionStorage implements LocalStorageLike {
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

let installed: PlatformAdapter | undefined;

export const installPlatformAdapter = (adapter: PlatformAdapter): void => {
    if (installed) {
        adapter.log.warn("PlatformAdapter already installed; replacing");
    }
    installed = adapter;

    // window.localStorage polyfill. ente's accounts-db.ts + session.ts read
    // this synchronously, hence the sync interface.
    if (typeof (globalThis as { localStorage?: unknown }).localStorage ===
        "undefined") {
        Object.defineProperty(globalThis, "localStorage", {
            value: adapter.localStorage,
            writable: false,
            configurable: false,
        });
    }

    // sessionStorage polyfill. ente's base/session.ts stores the encrypted
    // master key here. Backed by a distinct in-memory store so cross-store
    // bleed doesn't happen.
    if (typeof (globalThis as { sessionStorage?: unknown }).sessionStorage ===
        "undefined") {
        Object.defineProperty(globalThis, "sessionStorage", {
            value: new InMemorySessionStorage(),
            writable: false,
            configurable: false,
        });
    }

    // IndexedDB: fake-indexeddb/auto sets globalThis.indexedDB at import
    // time. ente-base/kv.ts (untouched upstream) wraps it via `idb`. Data
    // lives in-process; restart loses it. Persistence comes via a real
    // bun:sqlite-backed IDBFactory later (see SqliteKV — currently
    // unused).

    // FileReader polyfill. JSZip's blob-input path (used by ente's
    // encodeLivePhoto when packaging Live Photo halves) gates on
    // `typeof FileReader !== "undefined"` and falls back to a code path
    // that requires the input to already be a Uint8Array/ArrayBuffer.
    // Bun doesn't expose a global FileReader, so encodeLivePhoto sees
    // Bun's File class — which extends Blob — return through that
    // fallback and JSZip rejects it as "Can't read the data of
    // 'image.HEIC'. Is it in a supported JavaScript type ?".
    //
    // We only need the readAsArrayBuffer arm. Bun's `Blob.arrayBuffer()`
    // does the work; this is a thin adapter that fires the onload /
    // onerror event-handler properties the way JSZip expects.
    if (typeof (globalThis as { FileReader?: unknown }).FileReader ===
        "undefined") {
        class FileReaderPolyfill {
            onload:
                | ((event: { target: { result: ArrayBuffer } }) => void)
                | null = null;
            onerror:
                | ((event: { target: { error: unknown } }) => void)
                | null = null;
            readAsArrayBuffer(blob: Blob): void {
                Promise.resolve(blob.arrayBuffer()).then(
                    (result) => {
                        this.onload?.({ target: { result } });
                    },
                    (error: unknown) => {
                        this.onerror?.({ target: { error } });
                    },
                );
            }
        }
        Object.defineProperty(globalThis, "FileReader", {
            value: FileReaderPolyfill,
            writable: false,
            configurable: false,
        });
    }

    // globalThis.electron shim.
    //
    // Categories of methods, by how we handle them:
    //
    //   (a) Real upload/auth path: route to PlatformAdapter.
    //   (b) Logging: route to adapter.log so we see it on stderr.
    //   (c) Safe storage: report unavailable; ente's callers all have
    //       fallbacks that go through sessionStorage instead.
    //   (d) UI/desktop niceties: no-op.
    //   (e) Feature-gated (face/CLIP/lock): throw NotImplemented if
    //       called — we don't expect them in upload, and a loud failure
    //       is better than a silent wrong-answer.
    //
    // If the helper crashes with "electron.X is not a function", add X
    // here in the right bucket and move on.
    const notImplemented = (what: string) => () => {
        throw new Error(`electron.${what} not implemented in helper`);
    };
    const electronShim = {
        // (a) Upload/auth path → PlatformAdapter
        ffmpegExec: adapter.ffmpeg.exec.bind(adapter.ffmpeg),
        ffmpegDetermineVideoDuration:
            adapter.ffmpeg.determineVideoDuration.bind(adapter.ffmpeg),
        generateImageThumbnail:
            adapter.thumbnailer.generateImageThumbnail.bind(
                adapter.thumbnailer,
            ),
        markUploadedFile: adapter.ledger.markUploaded.bind(adapter.ledger),
        markUploadedZipItem: adapter.ledger.markZipItemUploaded.bind(
            adapter.ledger,
        ),

        // (b) Logging. ente's log.ts has already prefixed the message with
        // [info]/[warn]/[error] before calling electron.logToDisk — see
        // ente/web/packages/base/log.ts:84 (logInfo etc.). Going through
        // adapter.log.info here would prepend a second [info] tag (we saw
        // "[info] [info] Upload ... | start" in smoke output). Write the
        // already-formatted line straight to stderr instead.
        logToDisk: (message: string) => {
            process.stderr.write(message + "\n");
        },

        // (c) Safe storage — claim unavailable, ente falls back to
        // sessionStorage which we polyfill.
        isSafeStorageAvailable: () => false,
        masterKeyFromSafeStorage: async () => undefined,
        saveMasterKeyInSafeStorage: async (_masterKey: string) => {},
        appLockConfigFromSafeStorage: async () => undefined,
        saveAppLockConfigInSafeStorage: async (_config: unknown) => {},
        clearAppLockConfigFromSafeStorage: async () => {},

        // (d) Window focus/blur — no UI to track.
        onMainWindowFocus: (_listener?: () => void) => {},
        onMainWindowBlur: (_listener?: () => void) => {},

        // (d) UI niceties — return safe defaults.
        getNativeDeviceLockCapability: () => "unsupported" as const,
        promptDeviceLock: async () => ({ ok: false }),
        lastShownChangelogVersion: async () => undefined,
        setLastShownChangelogVersion: async (_v: number) => {},
        selectDirectory: async () => undefined,

        // (e) ML / face / CLIP — throw if reached. Upload shouldn't.
        computeCLIPImageEmbedding: notImplemented("computeCLIPImageEmbedding"),
        computeCLIPTextEmbeddingIfAvailable: notImplemented(
            "computeCLIPTextEmbeddingIfAvailable",
        ),
        computeFaceEmbeddings: notImplemented("computeFaceEmbeddings"),
        detectFaces: notImplemented("detectFaces"),
        convertToJPEG: notImplemented("convertToJPEG"),

        // fs / fsStatMtime — placeholder. If upload touches these, we
        // implement them against Bun.file / node:fs at that point. For
        // now, throw on access.
        get fs(): never {
            throw new Error("electron.fs not implemented in helper");
        },
        fsStatMtime: notImplemented("fsStatMtime"),
    };
    Object.defineProperty(globalThis, "electron", {
        value: electronShim,
        writable: false,
        configurable: false,
    });

    adapter.log.info("PlatformAdapter installed");
};

export const currentAdapter = (): PlatformAdapter => {
    if (!installed) {
        throw new Error(
            "PlatformAdapter not installed; call installPlatformAdapter() at startup",
        );
    }
    return installed;
};
