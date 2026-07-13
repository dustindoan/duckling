// PlatformAdapter — the seam between ente's upload/auth code and the host
// environment it ends up running in.
//
// Pattern borrowed from Bitwarden's `@bitwarden/common`: crypto + protocol
// stays in the shared (ente) side, platform glue lives behind this interface
// with one implementation per client.
//
// Today the only implementation is `BunAdapter` (see ./bun-adapter.ts).
// When iOS happens, "implement these interfaces in Rust" is the spec — not
// "reverse-engineer what we did to globalThis."

/**
 * Persistent key/value store. Backed by bun:sqlite or in-memory in this
 * implementation; on iOS it would be Core Data or a file-backed store.
 *
 * Replaces ente-base/kv (which uses `idb`).
 */
export interface KVStore {
    get(key: string): Promise<unknown>;
    getString(key: string): Promise<string | undefined>;
    getNumber(key: string): Promise<number | undefined>;
    getBoolean(key: string): Promise<boolean | undefined>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    clear(): Promise<void>;
}

/**
 * String-keyed string store, scoped to the helper instance. Synchronous
 * because ente's code reads it as `window.localStorage` and assumes sync
 * semantics. May be backed by a file for survival across restarts.
 */
export interface LocalStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    clear(): void;
    readonly length: number;
    key(index: number): string | null;
}

/**
 * Image thumbnail generator. Replaces electron.generateImageThumbnail.
 *
 * @param path Absolute path to the source image on disk.
 * @param maxDimension Bound on the longer edge of the output, in pixels.
 * @param maxSize Bound on the JPEG byte size; downscale until under this.
 */
export interface Thumbnailer {
    generateImageThumbnail(
        path: string,
        maxDimension: number,
        maxSize: number,
    ): Promise<Uint8Array>;
}

/**
 * FFmpeg command runner. Replaces electron.ffmpegExec and
 * electron.ffmpegDetermineVideoDuration. Signatures mirror ente's
 * `Electron` IPC contract (see `ente/web/packages/base/types/ipc.ts`).
 *
 * The `command` slots use placeholder tokens — `"FFMPEG"`, `"INPUT"`,
 * `"OUTPUT"` — that get substituted at exec time. ente builds the
 * command on the web side; the host substitutes its actual paths.
 *
 * `pathOrZipItem` is either an absolute file path or a `[zipPath,
 * entryName]` tuple. For zip items the host extracts the entry to a
 * temporary file before running ffmpeg.
 *
 * The HDR-aware command form (`{ default, hdr }`) lets ente specify a
 * different command for HDR vs SDR video. The host detects which to use
 * via a preliminary ffmpeg probe of the input's colour transfer — see
 * BunFFmpegRunner. Detection failures fall back to `.default` (HDR
 * mishandled looks washed out but doesn't fail the upload).
 */
export type ZipItem = [zipPath: string, entryName: string];
export type FFmpegCommand = string[] | { default: string[]; hdr: string[] };

export interface FFmpegRunner {
    exec(
        command: FFmpegCommand,
        pathOrZipItem: string | ZipItem,
        outputFileExtension: string,
    ): Promise<Uint8Array>;
    /**
     * Best-effort duration extraction. Implementations parse ffmpeg's
     * own stderr (no ffprobe assumed) — see ente's electron host code
     * and `videoDurationLineRegex`. Returns seconds, rounded up to match
     * web-side behaviour.
     */
    determineVideoDuration(pathOrZipItem: string | ZipItem): Promise<number>;
}

/**
 * Tracks files the helper has finished uploading. In the Electron app this
 * fed the desktop watch-folder feature so files weren't re-uploaded; for the
 * helper this can be a no-op (the macOS FileProvider extension is our watch
 * source and has its own dedup story).
 */
export interface UploadLedger {
    markUploaded(path: string, collectionID?: string): Promise<void>;
    markZipItemUploaded(zipPath: string, itemPath: string): Promise<void>;
}

/**
 * Logger. Goes to stderr today; future: structured ndjson to a file the
 * Swift app can tail.
 */
export interface Logger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export interface PlatformAdapter {
    kv: KVStore;
    localStorage: LocalStorageLike;
    thumbnailer: Thumbnailer;
    ffmpeg: FFmpegRunner;
    ledger: UploadLedger;
    log: Logger;
}
