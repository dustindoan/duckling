// Stub for @ffmpeg/ffmpeg. Copied into node_modules/@ffmpeg/ffmpeg/dist/esm/empty.mjs
// by scripts/link-ente.sh so it satisfies ente's `import { FFFSType, FFmpeg }
// from "@ffmpeg/ffmpeg"` at import time. We route real ffmpeg through
// PlatformAdapter.ffmpeg; anything that actually constructs FFmpeg here
// should crash loudly.

export const FFFSType = {
    MEMFS: "MEMFS",
    NODEFS: "NODEFS",
    WORKERFS: "WORKERFS",
};

export class FFmpeg {
    constructor() {
        throw new Error(
            "@ffmpeg/ffmpeg.FFmpeg constructed inside helper — should not " +
                "happen; ffmpeg goes through PlatformAdapter.ffmpeg (system binary)",
        );
    }
}
