// collections.* — manage the in-memory collectionCache Map<number, Collection>.
//
// createAlbum is imported from ente-new/photos/services/collection and called
// by collections.create; its return Collection (with decrypted key) is stored
// in collectionCache so getCachedCollection can service upload.put_file
// without a museum round-trip. collections.restore loads a persisted Collection
// back into that map. collections.delete calls deleteCollection on the server
// and removes from the map.
//
// List/share come later.

import {
    createAlbum,
    deleteCollection,
    pullCollectionFiles,
    pullCollections,
} from "ente-new/photos/services/collection";
import { findRecentUpload } from "../recent-uploads.ts";
import {
    findIndexedFile,
    indexedFilesInCollection,
    invalidateFileIndex,
} from "../file-index.ts";
import type { Collection } from "ente-media/collection";
import { fileCreationTime, fileFileName } from "ente-media/file-metadata";
import { currentAdapter } from "../../platform/install.ts";
import type { Dispatcher } from "../dispatch.ts";

interface CreateParams {
    name: string;
}

// Module-scope cache of collections we've created or fetched in this
// helper process. Lives as long as the process. upload.put_file looks
// up the full Collection (needs the decrypted key, owner info, etc.)
// from here by ID rather than re-fetching from the museum.
const collectionCache = new Map<number, Collection>();

// Whether this helper process has completed at least one full
// pullCollections + pullCollectionFiles cycle. Gates "cached" mode in
// collections.list_files: before the first pull the fdb is empty (it's
// an in-memory shim, reborn with every helper rotation), and serving an
// empty cache to an FP enumerator would tell fileproviderd the album is
// empty — it would delete the on-disk items to match.
let filesPulledOnce = false;

export const getCachedCollection = (id: number): Collection | undefined =>
    collectionCache.get(id);

// Fallback display name for ente's special collections (favorites,
// uncategorized) whose `name` arrives empty — ente's web/desktop client
// localizes these client-side. We don't localize; a fixed English label is
// fine for the FileProvider surface, and matches what Finder users expect.
const titleForSpecial = (type: string): string => {
    switch (type) {
        case "favorites":
            return "Favorites";
        case "uncategorized":
            return "Uncategorized";
        default:
            return "";
    }
};

export const registerCollectionMethods = (d: Dispatcher): void => {
    d.register("collections.create", async (params) => {
        const log = currentAdapter().log;
        const { name } = params as CreateParams;
        if (typeof name !== "string" || name.length === 0) {
            throw new Error("collections.create: params.name required");
        }
        log.info(`collections.create: ${name}`);
        const collection = await createAlbum(name);
        collectionCache.set(collection.id, collection);
        log.info(`collections.create: id=${collection.id}`);
        return {
            id: collection.id,
            name: collection.name,
            type: collection.type,
            // Worker-pool stashes this and replays via collections.restore
            // after rotation. The decrypted collection key lives inside
            // (which is the whole point — uploads need it).
            collection,
        };
    });

    // List the user's collections from the museum and seed the in-process
    // cache so upload.put_file can target any of them. pullCollections does
    // a delta sync backed by the localforage shim; on a fresh process
    // sinceTime=0, so it fetches + decrypts all.
    //
    // We surface all four ente CollectionType values:
    //   - "album"         user-created album, the normal upload target
    //   - "folder"        mobile-app album bound to an OS folder; treated
    //                     as an album alias by web/desktop
    //   - "uncategorized" special bucket for files not in any user album;
    //                     surfaces Photos.app-export orphans in Finder
    //   - "favorites"     special bucket for user-marked favorites
    //
    // FP enumeration wants all of them in Finder. Upload-target semantics
    // (e.g. "you can't upload into Favorites directly") are enforced by
    // upload.put_file callers, not by hiding entries here.
    //
    // Special collections (favorites, uncategorized) come back with an
    // empty `name`; fall back to a Title-Cased version of the type so the
    // FileProvider extension doesn't render "Untitled (<id>)".
    d.register("collections.list", async () => {
        const log = currentAdapter().log;
        log.info("collections.list: pulling collections");
        const collections = await pullCollections();
        const surfaced = collections.filter(
            (c) =>
                c.type === "album" ||
                c.type === "folder" ||
                c.type === "uncategorized" ||
                c.type === "favorites",
        );
        for (const c of surfaced) collectionCache.set(c.id, c);
        log.info(
            `collections.list: ${surfaced.length} surfaced of ${collections.length} total`,
        );
        return {
            collections: surfaced.map((c) => ({
                id: c.id,
                name: c.name || titleForSpecial(c.type),
                type: c.type,
            })),
        };
    });

    // List the files in one album, for FileProvider enumeration (mapping a
    // Finder folder's contents ↔ an album's files). Delta-syncs every
    // collection's files into the in-memory (localforage-shimmed) fdb, then
    // reads back just the requested album's. We pass the *full* collection
    // list to pullCollectionFiles (not just this id) because it prunes saved
    // files for collections absent from its argument — narrowing to one id
    // would wipe other albums' cached files on every call.
    //
    // `mode` selects freshness vs latency:
    //   - "pull" (default): museum delta-sync inline before reading the
    //     cache. CLI / smoke-test / prewarm semantics, unchanged.
    //   - "cached": serve straight from the local fdb — no museum round
    //     trip, no network in the reply path. Used by the FP enumeration
    //     path so a Finder folder-open never blocks on the museum (the
    //     Dropbox model: browse the replica, sync behind it). Falls back
    //     to a pull when this helper process has never pulled (cold start
    //     / just-rotated), since an empty fdb would otherwise enumerate
    //     every album as empty — and fileproviderd would delete the
    //     on-disk items to match.
    //
    // Returns lightweight summaries; decrypted keys and headers stay off the
    // wire. Timestamps are epoch microseconds (ente's metadata unit).
    d.register("collections.list_files", async (params) => {
        const log = currentAdapter().log;
        const { id, offset, limit, mode } = (params ?? {}) as {
            id?: number;
            offset?: number;
            limit?: number;
            mode?: "cached" | "pull";
        };
        if (typeof id !== "number") {
            throw new Error(
                "collections.list_files: params.id (number) required",
            );
        }
        log.info(
            `collections.list_files: id=${id} offset=${offset ?? 0} limit=${limit ?? 0} mode=${mode ?? "pull"}`,
        );
        const serveCached = mode === "cached" && filesPulledOnce;
        // Pagination optimization: only hit the museum on the first page
        // (offset 0 or missing). Subsequent pages read from the just-pulled
        // local cache — they'd otherwise add a museum delta-sync round-trip
        // per page (2 HTTP requests each via pullCollections +
        // pullCollectionFiles), turning a 5-page enumeration of a 22k-file
        // album into 10 round-trips and many seconds of latency. The
        // tradeoff: a file uploaded mid-pagination won't show up until the
        // next first-page call, which we accept since enumeration is a
        // snapshot operation by nature.
        if (!offset && !serveCached) {
            const collections = await pullCollections();
            for (const c of collections) collectionCache.set(c.id, c);
            if (!collections.some((c) => c.id === id)) {
                throw new Error(
                    `collections.list_files: no collection ${id}`,
                );
            }
            await pullCollectionFiles(collections, undefined);
            invalidateFileIndex(); // store changed → drop the cached snapshot
            filesPulledOnce = true;
        }
        const all = (await indexedFilesInCollection(id))
            // Stable order: sort by ente file ID so offset/limit pagination
            // is consistent across calls. Sort by ID rather than time so a
            // fresh-uploaded file showing up doesn't shift existing rows
            // mid-pagination (new file always lands at the end). The array
            // from the index is a fresh copy, so this in-place sort is safe.
            .sort((a, b) => a.id - b.id);
        // Pagination: optional offset/limit. When omitted, return the full
        // list (CLI / smoke-test callers). The FP extension uses these to
        // page large albums under fileproviderd's 20k-items-per-page limit,
        // and to keep each XPC reply payload small so the extension isn't
        // re-spawned mid-pagination from memory pressure.
        const start = typeof offset === "number" && offset > 0 ? offset : 0;
        const end =
            typeof limit === "number" && limit > 0
                ? Math.min(start + limit, all.length)
                : all.length;
        const page = all.slice(start, end);
        log.info(
            `collections.list_files: ${page.length} of ${all.length} file(s) in ${id} (offset=${start})`,
        );
        return {
            files: page.map((f) => ({
                id: f.id,
                name: fileFileName(f),
                fileType: f.metadata.fileType,
                size: f.info?.fileSize,
                creationTime: fileCreationTime(f),
                modificationTime: f.metadata.modificationTime,
                updationTime: f.updationTime,
            })),
            total: all.length,
        };
    });

    // Look up one (collection, file) pair's summary without fetching the
    // whole album. FP's item-lookup callers (item(for:), fetchContents,
    // deleteItem) target one ID at a time; without this they had to
    // listFiles the entire album per lookup — for a 22k-file album that's
    // O(N²) per Finder pass. Reads from the same shimmed localforage
    // cache that listFiles backs, so it's effectively a single Map.get.
    d.register("collections.get_file", async (params) => {
        const log = currentAdapter().log;
        const { id, collectionID } = (params ?? {}) as {
            id?: number;
            collectionID?: number;
        };
        if (typeof id !== "number") {
            throw new Error(
                "collections.get_file: params.id (number) required",
            );
        }
        if (typeof collectionID !== "number") {
            throw new Error(
                "collections.get_file: params.collectionID (number) required",
            );
        }
        // Check the in-memory recent-upload cache first: a file uploaded
        // moments ago isn't in the IDB store until the next delta-pull, and
        // this is the call the FP extension makes the instant a user opens it
        // (see recent-uploads.ts). Falling back to the O(n) whole-array load
        // only on a miss keeps the just-uploaded-file path O(1).
        const file =
            findRecentUpload(collectionID, id) ??
            (await findIndexedFile(collectionID, id));
        if (!file) {
            log.info(
                `collections.get_file: not found id=${id} collection=${collectionID}`,
            );
            return { file: null };
        }
        return {
            file: {
                id: file.id,
                name: fileFileName(file),
                fileType: file.metadata.fileType,
                size: file.info?.fileSize,
                creationTime: fileCreationTime(file),
                modificationTime: file.metadata.modificationTime,
                updationTime: file.updationTime,
            },
        };
    });

    // Re-seed the in-process collection cache from a previously-fetched
    // Collection. Used by the worker-pool cycler so a freshly-spawned
    // helper can answer upload.put_file for collections it never created
    // itself.
    d.register("collections.restore", async (params) => {
        const log = currentAdapter().log;
        const { collection } = (params ?? {}) as { collection?: Collection };
        if (!collection || typeof collection.id !== "number") {
            throw new Error(
                "collections.restore: params.collection (with id) required",
            );
        }
        collectionCache.set(collection.id, collection);
        log.info(`collections.restore: cached id=${collection.id}`);
        return { ok: true, id: collection.id };
    });

    // Delete an album on the remote. Invalidates the in-memory cache
    // entry so the helper doesn't hold stale Collection objects.
    d.register("collections.delete", async (params) => {
        const log = currentAdapter().log;
        const { id } = params as { id: number };
        if (typeof id !== "number") {
            throw new Error(
                "collections.delete: params must be { id: number }",
            );
        }
        log.info(`collections.delete: id=${id}`);
        await deleteCollection(id);
        collectionCache.delete(id);
        log.info(`collections.delete: done (id=${id})`);
        return { ok: true, id };
    });
};
