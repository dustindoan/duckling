// files.* — per-file operations against the museum.
//
// Files in ente belong to (collection, file) pairs: the same underlying bytes
// can be linked into multiple albums, each with its own collectionID/fileID
// row. The trash endpoint is keyed on the pair, so FileProvider's
// `deleteItem(<albumID, fileID>)` maps 1:1.

import {
    moveToTrash,
    pullCollectionFiles,
    pullCollections,
} from "ente-new/photos/services/collection";
import {
    updateFileFileName,
    updateFilePublicMagicMetadata,
} from "ente-new/photos/services/file";
import { findIndexedFile, invalidateFileIndex } from "../file-index.ts";
import { currentAdapter } from "../../platform/install.ts";
import type { Dispatcher } from "../dispatch.ts";

export const registerFileMethods = (d: Dispatcher): void => {
    // Move one (collection, file) pair to trash, matching ente's web client
    // "delete from album" semantics. The /files/trash endpoint accepts a list
    // of {fileID, collectionID} items; we always send a batch of one because
    // the FP extension calls deleteItem one file at a time.
    //
    // We look up the EnteFile from local state rather than synthesizing a
    // shape and casting: moveToTrash currently only reads .id + .collectionID,
    // but that's an implementation detail of the helper, not a contract — and
    // the lookup gives a clear error when the caller targets a file that
    // isn't actually in the named collection.
    d.register("files.trash", async (params) => {
        const log = currentAdapter().log;
        const { fileID, collectionID } = (params ?? {}) as {
            fileID?: number;
            collectionID?: number;
        };
        if (typeof fileID !== "number") {
            throw new Error("files.trash: params.fileID (number) required");
        }
        if (typeof collectionID !== "number") {
            throw new Error(
                "files.trash: params.collectionID (number) required",
            );
        }
        log.info(`files.trash: fileID=${fileID} collectionID=${collectionID}`);

        // Delta-sync state so a freshly-restored helper (or one that hasn't
        // enumerated this album yet) still finds the file. Both calls are
        // cheap when the state is already current.
        const collections = await pullCollections();
        await pullCollectionFiles(collections, undefined);
        invalidateFileIndex(); // store changed → drop the cached snapshot
        const file = await findIndexedFile(collectionID, fileID);
        if (!file) {
            // Idempotent semantics: the caller asked us to trash a file
            // that the museum no longer has (or never had) in this
            // collection. From the FileProvider extension's perspective —
            // "make this go away" — that goal is already achieved. Surface
            // success so fileproviderd lets the local item be removed
            // instead of retrying with throttle backoff (handoff §3d).
            log.info(
                `files.trash: no-op (file ${fileID} not in collection ${collectionID})`,
            );
            return { ok: true, fileID, collectionID, alreadyAbsent: true };
        }
        await moveToTrash([file]);
        invalidateFileIndex(); // trash removed the file from the store
        log.info(`files.trash: done fileID=${fileID}`);
        return { ok: true, fileID, collectionID };
    });

    // Rename one (collection, file) pair on the museum. In ente, the
    // user-visible file name is stored as `editedName` on the file's public
    // magic metadata — the original `metadata.title` is immutable post-upload.
    // updateFileFileName encrypts the new name with the file key and PUTs the
    // updated magic metadata blob; it does NOT touch local state. We delta-
    // sync afterwards so the helper's localforage cache reflects the new name
    // for subsequent enumerations — without this, an FP listFiles call right
    // after the rename would still surface the old name until the next first-
    // page enumeration triggered its own pull.
    d.register("files.rename", async (params) => {
        const log = currentAdapter().log;
        const { fileID, collectionID, newName } = (params ?? {}) as {
            fileID?: number;
            collectionID?: number;
            newName?: string;
        };
        if (typeof fileID !== "number") {
            throw new Error("files.rename: params.fileID (number) required");
        }
        if (typeof collectionID !== "number") {
            throw new Error(
                "files.rename: params.collectionID (number) required",
            );
        }
        if (typeof newName !== "string" || newName.length === 0) {
            // Magic metadata fields cannot be reset to nullish once set
            // (per ente's note in updateFileCaption), so an empty rename is
            // rejected outright rather than persisted as ambiguous state.
            throw new Error(
                "files.rename: params.newName (non-empty string) required",
            );
        }
        log.info(
            `files.rename: fileID=${fileID} collectionID=${collectionID} newName=${newName}`,
        );

        const collections = await pullCollections();
        await pullCollectionFiles(collections, undefined);
        invalidateFileIndex(); // store changed → drop the cached snapshot
        const file = await findIndexedFile(collectionID, fileID);
        if (!file) {
            throw new Error(
                `files.rename: file ${fileID} not in collection ${collectionID}`,
            );
        }
        await updateFileFileName(file, newName);
        // Re-pull so the museum's updated pubMagicMetadata (now carrying the
        // new editedName + bumped version) lands in the local cache. Without
        // this, the next collections.list_files (paginated, skips sync on
        // offset > 0) would surface the stale name from before the rename.
        await pullCollectionFiles(collections, undefined);
        invalidateFileIndex(); // re-pulled the renamed file → refresh the index
        log.info(`files.rename: done fileID=${fileID}`);
        return { ok: true, fileID, collectionID, newName };
    });

    // Override a file's creation time via pubMagicMetadata.editedTime —
    // ente's own "edit date" channel (fileCreationTime prefers editedTime
    // over metadata.creationTime everywhere). Exists for repairing files
    // whose capture date never made it into ente: formats that can't carry
    // EXIF fall back to file mtime at upload, and an mtime of "export
    // moment" permanently stamps them with the migration date.
    d.register("files.set_creation_time", async (params) => {
        const log = currentAdapter().log;
        const { fileID, collectionID, creationTime } = (params ?? {}) as {
            fileID?: number;
            collectionID?: number;
            /** Epoch MICROseconds (ente's metadata unit). */
            creationTime?: number;
        };
        if (typeof fileID !== "number") {
            throw new Error(
                "files.set_creation_time: params.fileID (number) required",
            );
        }
        if (typeof collectionID !== "number") {
            throw new Error(
                "files.set_creation_time: params.collectionID (number) required",
            );
        }
        if (
            typeof creationTime !== "number" ||
            !Number.isFinite(creationTime) ||
            creationTime <= 0
        ) {
            throw new Error(
                "files.set_creation_time: params.creationTime (epoch µs) required",
            );
        }
        log.info(
            `files.set_creation_time: fileID=${fileID} collectionID=${collectionID} → ${creationTime}`,
        );
        const collections = await pullCollections();
        await pullCollectionFiles(collections, undefined);
        invalidateFileIndex();
        const file = await findIndexedFile(collectionID, fileID);
        if (!file) {
            throw new Error(
                `files.set_creation_time: file ${fileID} not in collection ${collectionID}`,
            );
        }
        await updateFilePublicMagicMetadata(file, {
            editedTime: creationTime,
        });
        await pullCollectionFiles(collections, undefined);
        invalidateFileIndex();
        log.info(`files.set_creation_time: done fileID=${fileID}`);
        return { ok: true, fileID, collectionID, creationTime };
    });
};
