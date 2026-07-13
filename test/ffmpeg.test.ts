// Unit tests for the ffmpeg stderr parsers in bun-ffmpeg.ts. Pure
// string-in/value-out — no ffmpeg binary, no video files. The sample
// stream lines are real-world shapes lifted from ente's ffmpeg-worker.ts
// comments plus iPhone HDR capture output.

import { describe, expect, test } from "bun:test";
import {
    parseDurationFromStderr,
    stderrIndicatesHDR,
} from "../src/platform/bun-ffmpeg.ts";

const streamInfo = (videoLine: string) =>
    [
        "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mov':",
        "  Duration: 00:00:14.83, start: 0.000000, bitrate: 24276 kb/s",
        `  Stream #0:0[0x1](und): Video:${videoLine}`,
        "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 178 kb/s (default)",
        "",
    ].join("\n");

describe("stderrIndicatesHDR", () => {
    test("detects PQ (smpte2084) HDR — iPhone Dolby Vision capture", () => {
        expect(
            stderrIndicatesHDR(
                streamInfo(
                    " hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 24276 kb/s, 30 fps, 30 tbr, 600 tbn (default)",
                ),
            ),
        ).toBe(true);
    });

    test("detects HLG (arib-std-b67) HDR", () => {
        expect(
            stderrIndicatesHDR(
                streamInfo(
                    " h264 (High 10) ([27][0][0][0] / 0x001B), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 30 fps, 30 tbr, 90k tbn",
                ),
            ),
        ).toBe(true);
    });

    test("SDR h264 is not HDR", () => {
        expect(
            stderrIndicatesHDR(
                streamInfo(
                    " h264 (Constrained Baseline) (avc1 / 0x31637661), yuv420p(progressive), 480x270 [SAR 1:1 DAR 16:9], 539 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)",
                ),
            ),
        ).toBe(false);
    });

    test("HDR marker on a non-Video line does not count", () => {
        // The substring check applies only to the video stream line.
        const stderr = [
            "  Stream #0:0[0x1](und): Video: h264, yuv420p, 1920x1080, 30 fps",
            "  Stream #0:1[0x2](und): Data: none, smpte2084 metadata",
            "",
        ].join("\n");
        expect(stderrIndicatesHDR(stderr)).toBe(false);
    });

    test("no video stream line → false", () => {
        expect(stderrIndicatesHDR("")).toBe(false);
        expect(stderrIndicatesHDR("garbage output\nno streams here\n")).toBe(
            false,
        );
    });

    test("CRLF line endings", () => {
        expect(
            stderrIndicatesHDR(
                "  Stream #0:0: Video: hevc, yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160\r\n",
            ),
        ).toBe(true);
    });
});

describe("parseDurationFromStderr", () => {
    test("HH:MM:SS.ss rounds up", () => {
        expect(
            parseDurationFromStderr(
                "  Duration: 00:00:14.83, start: 0.000000, bitrate: 24276 kb/s\n",
            ),
        ).toBe(15);
    });

    test("hours contribute", () => {
        expect(
            parseDurationFromStderr(
                "  Duration: 01:02:03.00, start: 0.000000, bitrate: 100 kb/s\n",
            ),
        ).toBe(3600 + 120 + 3);
    });

    test("missing Duration line throws", () => {
        expect(() => parseDurationFromStderr("no duration here")).toThrow(
            /Cannot parse video duration/,
        );
    });
});
