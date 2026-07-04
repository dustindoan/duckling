// In-memory index over `savedCollectionFiles()` to avoid a full O(n)
// IndexedDB load + parse on every read.
//
// Why this exists: `collections.get_file`, `collections.list_files`, and the
// upload dedup pre-flight (`buildExistingFiles`), plus files.trash/rename and
// download, each called `savedCollectionFiles()` — which `localForage.getItem`s
// and deserializes the ENTIRE files array every time. At ~30k files that load
// is slow enough that a read storm (observed live: Spotlight indexing a
// just-completed album → a `fetchContents`/get_file flood) saturated the
// helper's single Bun event loop and cascaded into 30s RPC timeouts across
// whoami / get_file / list. (See project-on2-cache-refresh.)
//
// This module loads the array once, builds O(1) lookup maps, and serves reads
// from memory until the store changes. Callers MUST call `invalidateFileIndex()`
// after anything that mutates the store (every `pullCollectionFiles`, and
// `moveToTrash`); a TTL backstop covers any mutation path we don't explicitly
// hook. The recent-upload cache (recent-uploads.ts) still fronts get_file for
// just-uploaded files; this index is the fast path for everything already
// persisted.

import { savedCollectionFiles } from "ente-new/photos/services/photos-fdb";
import type { EnteFile } from "ente-media/file";

// Safety backstop: even with explicit invalidation, reload at least this often
// so a missed mutation path can't serve stale data indefinitely. During a pure
// read storm (no mutations) this caps the expensive load to once per window.
const TTL_MS = 60_000;

let cachedFiles: EnteFile[] | null = null;
let byKey = new Map<string, EnteFile>();
let byCollection = new Map<number, EnteFile[]>();
let loadedAt = 0;

// Dedupe concurrent (re)loads: a read storm hitting a cold/expired cache must
// trigger ONE savedCollectionFiles() load that everyone awaits — otherwise we
// reproduce the very O(n)-per-call storm this index exists to kill.
let loadingPromise: Promise<void> | null = null;

// Bumped on every invalidation. A reload that started before an invalidation
// (e.g. another handler's pull landed mid-load) is discarded and retried, so we
// never commit data that predates a known mutation.
let generation = 0;

const keyFor = (collectionID: number, id: number): string =>
    `${collectionID}:${id}`;

const rebuild = async (): Promise<void> => {
    const startGen = generation;
    const files = await savedCollectionFiles();
    if (startGen !== generation) {
        // Invalidated while we were loading — this snapshot may be stale.
        await rebuild();
        return;
    }
    const k = new Map<string, EnteFile>();
    const c = new Map<number, EnteFile[]>();
    for (const f of files) {
        k.set(keyFor(f.collectionID, f.id), f);
        const arr = c.get(f.collectionID);
        if (arr) arr.push(f);
        else c.set(f.collectionID, [f]);
    }
    cachedFiles = files;
    byKey = k;
    byCollection = c;
    loadedAt = Date.now();
};

const ensureLoaded = async (): Promise<void> => {
    if (cachedFiles !== null && Date.now() - loadedAt < TTL_MS) return;
    if (loadingPromise) {
        await loadingPromise;
        return;
    }
    loadingPromise = rebuild();
    try {
        await loadingPromise;
    } finally {
        loadingPromise = null;
    }
};

/**
 * Drop the cached snapshot. Call after any operation that changes the persisted
 * files store (every `pullCollectionFiles`, `moveToTrash`). The next read
 * reloads; an in-flight load is discarded via the generation guard.
 */
export const invalidateFileIndex = (): void => {
    cachedFiles = null;
    loadedAt = 0;
    generation++;
};

/** O(1) lookup of one (collection, file) pair. The storm's fast path. */
export const findIndexedFile = async (
    collectionID: number,
    id: number,
): Promise<EnteFile | undefined> => {
    await ensureLoaded();
    return byKey.get(keyFor(collectionID, id));
};

/**
 * Files in one collection, as a fresh array (safe for the caller to sort in
 * place). list_files is O(collection) anyway — the win there is skipping the
 * whole-store IDB reload, not the per-call allocation.
 */
export const indexedFilesInCollection = async (
    collectionID: number,
): Promise<EnteFile[]> => {
    await ensureLoaded();
    const arr = byCollection.get(collectionID);
    return arr ? arr.slice() : [];
};

/**
 * All files across all collections, for cross-collection dedup. Returns the
 * cached instance — callers must NOT mutate it (buildExistingFiles copies via
 * `.slice()` before merging).
 */
export const allIndexedFiles = async (): Promise<EnteFile[]> => {
    await ensureLoaded();
    return cachedFiles ?? [];
};
