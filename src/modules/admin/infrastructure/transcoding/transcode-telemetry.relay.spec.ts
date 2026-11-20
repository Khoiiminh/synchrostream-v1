import { ConfigService } from "@nestjs/config";
import { TranscodeTelemetryRelay } from "./transcode-telemetry.relay.js";

const MOVIE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function setup() {
    const gateway = {
        broadcastMovieStatusUpdate: jest.fn(),
        broadcastTranscodeProgress: jest.fn(),
    };
    const relay = new TranscodeTelemetryRelay({} as ConfigService, gateway);
    return { relay, gateway };
}

describe("TranscodeTelemetryRelay (worker → admin UI)", () => {
    it("re-emits status as the unchanged movie_status_changed payload", () => {
        const { relay, gateway } = setup();
        relay.handleMessage(
            JSON.stringify({
                type: "status",
                movieId: MOVIE_ID,
                status: "AVAILABLE",
                hlsUrl: `film/${MOVIE_ID}/master.m3u8`,
            }),
        );
        expect(gateway.broadcastMovieStatusUpdate).toHaveBeenCalledWith({
            movieId: MOVIE_ID,
            status: "AVAILABLE",
            hlsUrl: `film/${MOVIE_ID}/master.m3u8`,
        });
    });

    it("re-emits progress", () => {
        const { relay, gateway } = setup();
        relay.handleMessage(
            JSON.stringify({
                type: "progress",
                movieId: MOVIE_ID,
                phase: "ENCODING",
                percent: 42,
            }),
        );
        expect(gateway.broadcastTranscodeProgress).toHaveBeenCalledWith({
            movieId: MOVIE_ID,
            phase: "ENCODING",
            percent: 42,
        });
    });

    it("drops malformed messages", () => {
        const { relay, gateway } = setup();
        expect(() => relay.handleMessage("{not json")).not.toThrow();
        relay.handleMessage(JSON.stringify({ type: "other" }));
        expect(gateway.broadcastMovieStatusUpdate).not.toHaveBeenCalled();
        expect(gateway.broadcastTranscodeProgress).not.toHaveBeenCalled();
    });
});
