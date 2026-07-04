// download.* — pulls a file's plaintext bytes off the museum.
//
// Driven by FileProvider's `fetchContents` (double-click in Finder). The
// helper does the network fetch + decryption (using ente's downloadManager,
// which goes through the same audited libsodium path we use for uploads),
// writes the plaintext to `/tmp/`, and returns the path. The app opens that
// path as an FD and ships it to the (sandboxed) extension over NSXPC — same
// FD-passing pattern as upload in reverse (see handoff §3a–3c).

import { writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadManager } from "ente-gallery/services/download";
import {
    pullCollectionFiles,
    pullCollections,
} from "ente-new/photos/services/collection";
import { fileFileName } from "ente-media/file-metadata";
import { findRecentUpload } from "../recent-uploads.ts";
import { findIndexedFile, invalidateFileIndex } from "../file-index.ts";
import { currentAdapter } from "../../platform/install.ts";
import type { Dispatcher } from "../dispatch.ts";

export const registerDownloadMethods = (d: Dispatcher): void => {
    // Fetch one (collection, file) pair's decrypted bytes onto local disk.
    // collectionID is required because the same file row in ente may be
    // linked into multiple collections; the FP identity is the pair, and
    // we want errors keyed to it (not "file 42 exists but not in album 99").
    //
    // `outPath`: optional. When set, the helper writes there. When omitted,
    // a `/tmp/` path with the file's extension is chosen and returned. The
    // FP-extension path will let us omit it (the app picks a temp path it
    // controls); the CLI path may want to pin it for explicitness.
    d.register("download.get_file", async (params) => {
        const log = currentAdapter().log;
        const {
            fileID,
            collectionID,
            outPath,
        } = (params ?? {}) as {
            fileID?: number;
            collectionID?: number;
            outPath?: string;
        };
        if (typeof fileID !== "number") {
            throw new Error("download.get_file: params.fileID (number) required");
        }
        if (typeof collectionID !== "number") {
            throw new Error(
                "download.get_file: params.collectionID (number) required",
            );
        }
        log.info(
            `download.get_file: fileID=${fileID} collectionID=${collectionID}`,
        );

        // Fast path: the EnteFile (carrying the decryption key + header) is
        // almost always already known — the FP extension enumerated the album
        // before fetching contents, or it was just uploaded. Resolve from the
        // recent-upload cache + in-memory index in O(1). Only fall back to a
        // delta-sync if the file is genuinely not local yet, so a
        // fetchContents storm (e.g. Spotlight indexing a large album) doesn't
        // reload the whole store per file — the 30k-scale timeout cascade. The
        // key/header are immutable post-upload, so a cached copy is correct.
        let file =
            findRecentUpload(collectionID, fileID) ??
            (await findIndexedFile(collectionID, fileID));
        if (!file) {
            const collections = await pullCollections();
            await pullCollectionFiles(collections, undefined);
            invalidateFileIndex();
            file = await findIndexedFile(collectionID, fileID);
        }
        if (!file) {
            throw new Error(
                `download.get_file: no file ${fileID} in collection ${collectionID}`,
            );
        }

        const fileName = fileFileName(file);
        const path = outPath ?? defaultTempPath(fileName);

        // downloadManager.fileStream picks the right credential context
        // (photos/public-albums/public-memory) and returns a *decrypted*
        // stream. For images + live photos it's already buffered to an
        // Uint8Array stream; for videos it's a chunked decryption stream
        // driven by libsodium init/decryptChunk.
        const stream = await downloadManager.fileStream(file);
        if (!stream) {
            throw new Error(
                `download.get_file: fileStream returned null for ${fileID}`,
            );
        }
        // Slurp into a buffer then write — cleaner than piping a web stream
        // through node:fs.WritableStream, and the FP fetch happens at user
        // gesture (double-click) so peak memory of one file at a time is
        // acceptable. If a user opens a 4K video the worker-pool cycle
        // already bounds long-term residency.
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        await writeFile(path, bytes);

        log.info(
            `download.get_file: wrote ${path} (${bytes.byteLength} bytes)`,
        );
        return { path, fileName, size: bytes.byteLength };
    });
};

const defaultTempPath = (fileName: string): string => {
    const ext = extname(basename(fileName));
    const id = crypto.randomUUID();
    const leaf = ext ? `coralstack-download-${id}${ext}` : `coralstack-download-${id}`;
    return join(tmpdir(), leaf);
};
