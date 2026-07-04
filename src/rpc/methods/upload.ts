// upload.* RPC methods.
//
// Wraps ente's gallery/services/upload/upload-service.ts. We call its
// `upload()` function directly (skipping the apps/photos UploadManager,
// which carries UI service plumbing we don't need).
//
// Safety: this is the first RPC that WRITES to the user's museum.
// Requirements:
//   - `path` must be an absolute, existing file path.
//   - `collectionID` must be explicit; never defaulted.
//   - The target collection must have been seen during this process
//     (via collections.create). No silent fetch of "any collection".

import { readFileSync, statSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { createComlinkCryptoWorker } from "ente-base/crypto";
import type { CryptoWorker } from "ente-base/crypto/worker";
import {
    pullCollectionFiles,
    pullCollections,
} from "ente-new/photos/services/collection";
import { allIndexedFiles, invalidateFileIndex } from "../file-index.ts";
import uploadService, {
    upload,
} from "ente-gallery/services/upload/upload-service";
import type { UploadableUploadItem } from "ente-gallery/services/upload";
import type { EnteFile } from "ente-media/file";
import { metadataHash } from "ente-media/file-metadata";
import { currentAdapter } from "../../platform/install.ts";
import { getCachedCollection } from "./collections.ts";
import { noteUploadedFile, recentUploads } from "../recent-uploads.ts";
import type { Dispatcher } from "../dispatch.ts";

/// Finder's name-collision suffix: a space, an opening paren, digits, a
/// closing paren, right before the extension — e.g. `IMG_3846 (1).HEIC`.
/// macOS (and Photos.app export) appends this when a file of the target
/// name already exists in the destination. In our FileProvider pipeline
/// that destination is the album folder, so this suffix essentially
/// always means "the same asset was exported again over a copy that's
/// still here" — i.e. a resumed export. We use its PRESENCE as the gate
/// for the content-hash dedup pre-check below so a fresh export (all
/// canonical names) pays no extra hashing.
const finderCollisionSuffix = / \(\d+\)$/;

const hasCollisionSuffix = (filename: string): boolean => {
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    return finderCollisionSuffix.test(stem);
};

/// Full-content BLAKE2b hash, base64 — identical to ente's internal
/// `computeHash`. ente streams the file in chunks via
/// chunkHashInit/Update/Final; because crypto_generichash is a
/// byte-streaming hash, feeding the whole buffer in one update produces
/// the exact same digest. We rely on that equality so the hash we
/// compute here matches the `metadata.hash` ente stored on first upload.
const computeContentHash = async (
    bytes: Uint8Array,
    worker: CryptoWorker,
): Promise<string> => {
    const state = await worker.chunkHashInit();
    await worker.chunkHashUpdate(state, bytes);
    return worker.chunkHashFinal(state);
};

/// Name-agnostic dedup pre-check. ente's own `areFilesSame` gates on
/// filename BEFORE hash, so a resumed export whose files arrive with a
/// Finder ` (1)` suffix never matches the stored canonical name and
/// re-uploads as a duplicate. This checks by content hash alone: if a
/// file with the same hash already lives in `collectionID`, return it so
/// the caller can short-circuit to an `alreadyUploaded` result.
///
/// `hash` is the plain content hash for a single file, or
/// `${imageHash}:${videoHash}` for a live photo (matching how ente
/// builds the stored live-photo hash). Compared against each candidate
/// via ente's exported `metadataHash`, which reconstructs the
/// `image:video` form for stored live photos.
const findHashDuplicateInCollection = (
    existingFiles: EnteFile[],
    collectionID: number,
    hash: string,
): EnteFile | undefined =>
    existingFiles.find(
        (f) =>
            f.collectionID === collectionID &&
            metadataHash(f.metadata) === hash,
    );

/// Build the `existingFiles` array ente's `upload()` needs for hash-based
/// dedup. Self-warms the IDB if it's cold for `collectionID` so a
/// freshly-spawned helper (e.g. just after a rotation, when only
/// `auth.restore` + `listAlbums` have run) doesn't miss every dedup
/// opportunity until something else triggers a `list_files`.
///
/// `pullCollectionFiles` is delta-based after the first sync, so once the
/// cache is hot this function is just a `savedCollectionFiles()` read and
/// an array filter — cheap. The expensive arm only fires when the helper
/// has genuinely never seen files for this collection.
///
/// Returns ALL files across ALL collections (not just `collectionID`) so
/// ente's cross-collection symlink path can fire when the same content
/// already exists in a different album.
const buildExistingFiles = async (
    collectionID: number,
): Promise<EnteFile[]> => {
    const log = currentAdapter().log;
    let all = await allIndexedFiles();
    const haveAnyForCollection = all.some(
        (f) => f.collectionID === collectionID,
    );
    if (!haveAnyForCollection) {
        // Cold cache for this collection. Either (a) helper just spawned
        // and the detached prewarm hasn't reached this album yet, (b)
        // helper rotated and post-rotation prewarm doesn't exist, or
        // (c) genuinely empty collection. All three resolve via a
        // delta-sync — cheap when nothing changed museum-side. (The
        // collections.list_files RPC also writes to its module-local
        // collectionCache map for getCachedCollection lookups, but we
        // don't need that here — the caller already validated the
        // collection via getCachedCollection above.)
        log.info(
            `upload: warming dedup cache for collection ${collectionID}`,
        );
        const collections = await pullCollections();
        await pullCollectionFiles(collections, undefined);
        invalidateFileIndex();
        all = await allIndexedFiles();
    }
    // Merge in files uploaded moments ago that haven't been persisted to the
    // IDB store yet (see recent-uploads.ts). Without this, two identical files
    // uploaded back-to-back wouldn't dedup — the second wouldn't see the first
    // until a delta-pull. The old per-upload full refresh used to cover this;
    // the recent-upload cache replaces it. Dedupe by (collection, id) so a file
    // present in both lists isn't double-counted.
    const seen = new Set(all.map((f) => `${f.collectionID}:${f.id}`));
    const merged = all.slice();
    for (const f of recentUploads()) {
        const k = `${f.collectionID}:${f.id}`;
        if (!seen.has(k)) {
            seen.add(k);
            merged.push(f);
        }
    }
    return merged;
};

interface PutFileParams {
    path: string;
    collectionID: number;
    // Optional override for the user-visible file name. When the caller
    // streams bytes through a staged /tmp/coralstack-upload-<uuid>.<ext>
    // path (FP extension → app via FD passing → app writes to /tmp →
    // helper), `basename(path)` would carry the synthetic UUID name
    // into ente as the canonical title — wrong from the user's POV. The
    // app passes the original filename here so ente stores it intact.
    // Falls back to basename(path) for callers (CLI / smoke tests) that
    // upload a real path with the intended name baked in.
    fileName?: string;
}

interface PutLivePhotoParams {
    // Absolute path to the staged still (HEIC/JPEG) and motion (MOV) files.
    // Both halves must exist on disk before the call — UploadHost stages
    // each half from the FP extension's FileHandle into /tmp before
    // calling this method, the same way put_file stages its single input.
    stillPath: string;
    motionPath: string;
    collectionID: number;
    // User-visible filenames preserved into ente (same fileName-override
    // rationale as PutFileParams). The still's name is used as the live
    // photo's canonical name — that's what ente's readLivePhotoDetails
    // does too (live photo extension = image component extension).
    stillFileName?: string;
    motionFileName?: string;
}

// Staged upload inputs arrive as `/tmp/coralstack-upload-<uuid>.<ext>` files
// that UploadHost writes out of the FileProvider extension's FileHandle (FP
// extension → app via FD passing → app writes to /tmp → helper reads here).
// The helper reads the whole file into memory up front, so once the upload
// call returns the temp file is dead weight — and nobody else reliably
// deletes it. Leaving it behind leaks roughly one temp file per upload, which
// silently filled the disk to 99% and stalled a multi-day export (Photos.app
// pauses iCloud sync when local storage runs low). We delete it in a `finally`
// so it's reclaimed on success, dedup-hit, and error paths alike.
//
// Guarded by the synthetic name prefix: a CLI / smoke-test caller passes a
// real source path (no override), and we must never delete the user's own
// file. Only paths whose basename carries our staging prefix are touched.
const STAGED_INPUT_PREFIX = "coralstack-upload-";
const cleanupStagedInput = (path: string): void => {
    if (!basename(path).startsWith(STAGED_INPUT_PREFIX)) return;
    try {
        unlinkSync(path);
    } catch {
        // Best-effort: already gone, or a concurrent cleanup won the race.
    }
};

export const registerUploadMethods = (d: Dispatcher): void => {
    d.register("upload.put_file", async (params) => {
        const log = currentAdapter().log;
        const { path, collectionID, fileName: fileNameOverride } =
            params as PutFileParams;

        if (typeof path !== "string" || path.length === 0) {
            throw new Error("upload.put_file: params.path required");
        }
        try {
        if (typeof collectionID !== "number" || !Number.isFinite(collectionID)) {
            throw new Error("upload.put_file: params.collectionID required");
        }
        const collection = getCachedCollection(collectionID);
        if (!collection) {
            throw new Error(
                `upload.put_file: collection ${collectionID} not in cache — ` +
                    `create it via collections.create or add a collections.get fetch first`,
            );
        }

        // Read the file from disk into a web File object. ente's
        // upload() distinguishes File vs FileAndPath at multiple points;
        // FileAndPath is the desktop-app shape (file + absolute path),
        // which is what we have natively.
        const stat = statSync(path);
        if (!stat.isFile()) {
            throw new Error(`upload.put_file: not a regular file: ${path}`);
        }
        // Prefer the explicit override; otherwise infer from the path.
        // The override matters when bytes were streamed in via a staged
        // temp file whose name has nothing to do with the user's
        // original — see the PutFileParams.fileName comment.
        const fileName =
            typeof fileNameOverride === "string" && fileNameOverride.length > 0
                ? fileNameOverride
                : basename(path);
        const bytes = readFileSync(path);
        // Floor mtimeMs: Bun/macOS gives sub-millisecond fractional
        // precision; ente later multiplies by 1000 (→ microseconds) and
        // ensureInteger throws on the .5. The user-observable timestamp
        // is unchanged — we lose at most one millisecond of precision.
        const file = new File([bytes], fileName, {
            lastModified: Math.floor(stat.mtimeMs),
        });
        log.info(
            `upload.put_file: ${path} (${stat.size} bytes) → collection ${collectionID}`,
        );

        // Build the UploadableUploadItem.
        const item: UploadableUploadItem = {
            localID: Date.now(), // any unique-per-process integer
            collectionID,
            fileName,
            isLivePhoto: false,
            uploadItem: { file, path },
            pathPrefix: undefined,
            collection,
        };

        // Get a CryptoWorker handle. Our shim's createComlinkCryptoWorker
        // returns a fake worker whose .remote is libsodium — same method
        // names, called inline on the main thread. ente's upload() does
        // `await comlinkWorker.remote.someMethod(...)` which becomes
        // `await libsodium.someMethod(...)`. Same shape.
        const comlinkWorker = createComlinkCryptoWorker();
        const worker = (await comlinkWorker.remote) as unknown as CryptoWorker;

        // Upload context: no UI, so progress + cancel are no-ops.
        // isCFUploadProxyDisabled: true → use direct PUT to the presigned
        // S3 URL. Without this, ente routes through Cloudflare's
        // /file-upload worker, which a self-hosted museum doesn't have
        // (results in HTTP 404).
        let aborted = false;
        const uploadContext = {
            abortIfCancelled: () => {
                if (aborted) throw new Error("Upload cancelled");
            },
            updateUploadProgress: (_localID: number, _percentage: number) => {},
            isCFUploadProxyDisabled: true,
        };

        // UploadService singleton needs setup before upload(): init()
        // gates the public-albums vs private branch, setFileCount() seeds
        // the upload-URL refill counter. Without these, getUploadURL()
        // sees an empty pending count and throws "Failed to obtain upload URL".
        uploadService.init(undefined);
        await uploadService.setFileCount(1);

        // Dedup pre-flight. ente's `upload()` checks the new file's hash
        // against this array via `areFilesSame`. If a match exists in the
        // same collection it returns `alreadyUploaded` (no museum write);
        // if a match exists in a different collection it adds a symlink
        // so the file appears in both without duplicating storage. Skip
        // and you get an O(N²) duplicate-explosion on re-export — which
        // is the failure mode that motivated this fix.
        //
        // `buildExistingFiles` self-warms the cache if it's cold for
        // this collection (post-rotation, detached-prewarm-not-yet-done,
        // never-listed-album), so dedup is robust even on a freshly-
        // spawned helper.
        const existingFiles = await buildExistingFiles(collectionID);

        // Name-agnostic retry dedup. ente's areFilesSame gates on filename
        // before hash, so a resumed export whose files arrive with a
        // Finder ` (1)` collision suffix would slip past ente's own dedup
        // and re-upload. Only runs when the suffix is present, so a fresh
        // export (canonical names) pays no extra hashing.
        if (hasCollisionSuffix(fileName)) {
            const hash = await computeContentHash(bytes, worker);
            const dup = findHashDuplicateInCollection(
                existingFiles,
                collectionID,
                hash,
            );
            if (dup) {
                log.info(
                    `upload.put_file: hash-dedup hit for ${fileName} → existing file ${dup.id} (skipping re-upload)`,
                );
                return { type: "alreadyUploaded", file: dup };
            }
        }

        const result = await upload(
            item,
            undefined, // uploaderName — display only
            existingFiles,
            new Map(), // parsedMetadataJSONMap — no Takeout sidecars
            worker,
            uploadContext,
        );

        log.info(`upload.put_file: result type=${(result as { type?: string }).type ?? "unknown"}`);
        // Stash the canonical EnteFile so collections.get_file resolves it in
        // O(1) before the next delta-pull persists it (closes the open-in-
        // Preview race without the old per-upload full refresh). All success
        // arms carry `.file`; the failure arms don't.
        if ("file" in result) noteUploadedFile(result.file);
        return result;
        } finally {
            cleanupStagedInput(path);
        }
    });

    // Coalesce a HEIC/JPEG still + MOV motion pair into one ente livePhoto
    // file. The decision driving this RPC lives at
    // docs/decision-fp-livephoto-identity.md — UploadHost's pair buffer
    // arranges that both halves' createItem completion handlers reply with
    // the same canonical fileID returned here, which the FileProvider
    // framework then merges on disk.
    //
    // Shape mirrors put_file: read both files into File objects, dispatch
    // through ente's `upload()` with isLivePhoto:true. The upload service
    // branches on isLivePhoto and consumes `livePhotoAssets` instead of
    // `uploadItem` — see readLivePhotoDetails / extractLivePhotoMetadata
    // in ente/web/packages/gallery/services/upload/upload-service.ts.
    d.register("upload.put_live_photo", async (params) => {
        const log = currentAdapter().log;
        const {
            stillPath,
            motionPath,
            collectionID,
            stillFileName: stillOverride,
            motionFileName: motionOverride,
        } = params as PutLivePhotoParams;

        if (typeof stillPath !== "string" || stillPath.length === 0) {
            throw new Error("upload.put_live_photo: params.stillPath required");
        }
        if (typeof motionPath !== "string" || motionPath.length === 0) {
            throw new Error("upload.put_live_photo: params.motionPath required");
        }
        try {
        if (typeof collectionID !== "number" || !Number.isFinite(collectionID)) {
            throw new Error("upload.put_live_photo: params.collectionID required");
        }
        const collection = getCachedCollection(collectionID);
        if (!collection) {
            throw new Error(
                `upload.put_live_photo: collection ${collectionID} not in cache — ` +
                    `create it via collections.create or add a collections.get fetch first`,
            );
        }

        const stillStat = statSync(stillPath);
        const motionStat = statSync(motionPath);
        if (!stillStat.isFile()) {
            throw new Error(
                `upload.put_live_photo: not a regular file: ${stillPath}`,
            );
        }
        if (!motionStat.isFile()) {
            throw new Error(
                `upload.put_live_photo: not a regular file: ${motionPath}`,
            );
        }

        const stillName =
            typeof stillOverride === "string" && stillOverride.length > 0
                ? stillOverride
                : basename(stillPath);
        const motionName =
            typeof motionOverride === "string" && motionOverride.length > 0
                ? motionOverride
                : basename(motionPath);

        const stillBytes = readFileSync(stillPath);
        const motionBytes = readFileSync(motionPath);
        const stillFile = new File([stillBytes], stillName, {
            lastModified: Math.floor(stillStat.mtimeMs),
        });
        const motionFile = new File([motionBytes], motionName, {
            lastModified: Math.floor(motionStat.mtimeMs),
        });
        log.info(
            `upload.put_live_photo: still=${stillName} (${stillStat.size}b) + motion=${motionName} (${motionStat.size}b) → collection ${collectionID}`,
        );

        const item: UploadableUploadItem = {
            localID: Date.now(),
            collectionID,
            // ente uses the image (still) component's name as the canonical
            // live photo filename, so mirror that here. See readLivePhotoDetails.
            fileName: stillName,
            isLivePhoto: true,
            // For Live Photos, uploadItem is unused in the isLivePhoto
            // branch — upload-service.ts dispatches off livePhotoAssets.
            uploadItem: undefined,
            livePhotoAssets: {
                image: { file: stillFile, path: stillPath },
                video: { file: motionFile, path: motionPath },
            },
            pathPrefix: undefined,
            collection,
        };

        const comlinkWorker = createComlinkCryptoWorker();
        const worker = (await comlinkWorker.remote) as unknown as CryptoWorker;

        let aborted = false;
        const uploadContext = {
            abortIfCancelled: () => {
                if (aborted) throw new Error("Upload cancelled");
            },
            updateUploadProgress: (_localID: number, _percentage: number) => {},
            isCFUploadProxyDisabled: true,
        };

        uploadService.init(undefined);
        await uploadService.setFileCount(1);

        // Same dedup pre-flight as put_file. Live photo hashes cover both
        // halves (hash = `${imageHash}:${videoHash}` — see
        // metadataHash/areFilesSame), so a re-exported pair matches its
        // earlier upload and resolves as alreadyUploaded / symlink instead
        // of a duplicate. A full-library re-export after a partial failure
        // is exactly the case this protects.
        const existingFiles = await buildExistingFiles(collectionID);

        // Name-agnostic retry dedup (see put_file). On a resumed export
        // both halves arrive with a Finder ` (1)` suffix; gate on the
        // still's name (ente's canonical live-photo name). The live-photo
        // hash is `${imageHash}:${videoHash}` — exactly what metadataHash
        // reconstructs for a stored live photo — so a re-exported pair
        // matches its first upload by content alone.
        if (hasCollisionSuffix(stillName)) {
            const imageHash = await computeContentHash(stillBytes, worker);
            const videoHash = await computeContentHash(motionBytes, worker);
            const dup = findHashDuplicateInCollection(
                existingFiles,
                collectionID,
                `${imageHash}:${videoHash}`,
            );
            if (dup) {
                log.info(
                    `upload.put_live_photo: hash-dedup hit for ${stillName} → existing file ${dup.id} (skipping re-upload)`,
                );
                return { type: "alreadyUploaded", file: dup };
            }
        }

        const result = await upload(
            item,
            undefined,
            existingFiles,
            new Map(),
            worker,
            uploadContext,
        );

        log.info(
            `upload.put_live_photo: result type=${(result as { type?: string }).type ?? "unknown"}`,
        );
        // See put_file: stash the canonical EnteFile for O(1) get_file.
        if ("file" in result) noteUploadedFile(result.file);
        return result;
        } finally {
            cleanupStagedInput(stillPath);
            cleanupStagedInput(motionPath);
        }
    });
};
