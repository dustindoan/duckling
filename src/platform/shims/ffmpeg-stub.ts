// Stub for @ffmpeg/ffmpeg.
//
// The npm package ships an empty.mjs for the Node export condition (real
// module only loads in browsers, since it depends on Web Workers + wasm).
// ente's gallery/services/ffmpeg imports { FFFSType, FFmpeg } from it
// purely as types at the call sites we exercise.
//
// We route real ffmpeg through PlatformAdapter.ffmpeg (shells out to the
// system binary), not through @ffmpeg's wasm. So this stub just needs to
// satisfy the type and import-time existence checks. Any consumer that
// actually `new FFmpeg()`s should crash loudly.

export const FFFSType = {
    MEMFS: "MEMFS",
    NODEFS: "NODEFS",
    WORKERFS: "WORKERFS",
} as const;

export class FFmpeg {
    constructor() {
        throw new Error(
            "@ffmpeg/ffmpeg.FFmpeg constructed inside helper — should not " +
                "happen; ffmpeg goes through PlatformAdapter.ffmpeg (system binary)",
        );
    }
}
