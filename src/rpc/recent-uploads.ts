// In-memory cache of recently-uploaded files, keyed by `${collectionID}:${id}`.
//
// Why this exists: after `upload.put_file` succeeds, the new file is NOT yet in
// the IDB-backed `savedCollectionFiles()` store (ente's `upload()` doesn't write
// it back). The store only learns about it on the next museum delta-pull. So
// `collections.get_file` — which the FileProvider extension calls the instant a
// user opens a just-uploaded file in Preview — would return null, and
// fileproviderd would treat the item as removed and delete it from disk (the
// "open in Preview → file disappears" failure).
//
// The previous fix was to force a full `listFiles` (museum delta-sync +
// whole-array `savedCollectionFiles()` load/sort) after EVERY upload. That made
// the per-upload cost grow with collection size → O(n²) over a migration
// (see the project-on2-cache-refresh note).
//
// This cache closes the same race in O(1): the upload result already carries the
// canonical `EnteFile`, so we stash it here and have `collections.get_file`
// (and the hash-dedup `existingFiles` set) consult it first. No IDB read, no
// museum round-trip per upload. Entries are superseded for real once the next
// delta-pull persists them into `savedCollectionFiles()`; this is purely the
// bridge across that window.
//
// Bounded FIFO so a long migration can't grow it without limit. The cap only
// needs to cover (a) the open-in-Preview race window and (b) in-batch dedup of
// back-to-back identical files — both short-lived — so a few thousand entries
// is ample. Note this lives in the helper process; a worker rotation drops it,
// which is fine: the rotation re-seeds `savedCollectionFiles()` via its
// collection re-pull, so the file is found there afterward.

import type { EnteFile } from "ente-media/file";

const MAX_ENTRIES = 4096;

// Map preserves insertion order, giving us FIFO eviction for free.
const cache = new Map<string, EnteFile>();

const keyFor = (collectionID: number, id: number): string =>
    `${collectionID}:${id}`;

/** Record a just-uploaded (or just-symlinked/deduped) file. */
export const noteUploadedFile = (file: EnteFile): void => {
    const k = keyFor(file.collectionID, file.id);
    // Re-insert to move it to the newest FIFO slot.
    if (cache.has(k)) cache.delete(k);
    cache.set(k, file);
    if (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
};

/** Look up a recently-uploaded file by its (collection, file) identity. */
export const findRecentUpload = (
    collectionID: number,
    id: number,
): EnteFile | undefined => cache.get(keyFor(collectionID, id));

/**
 * All recently-uploaded files, for merging into the hash-dedup `existingFiles`
 * set so back-to-back identical uploads dedup even before the file lands in the
 * IDB store. Returned across all collections because ente's dedup is
 * cross-collection (it adds a symlink when the bytes already exist elsewhere).
 */
export const recentUploads = (): EnteFile[] => [...cache.values()];
