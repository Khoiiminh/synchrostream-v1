import {
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from "@nestjs/common";
import {
    MediaConflict,
    MediaForbidden,
    MediaNotFound,
} from "../domain/errors.js";
import { OpenSessionConflict } from "../application/ports/media-session-store.port.js";
import {
    rethrowAsHttp,
    toHttpException,
    withHttpErrors,
} from "./error-mapper.js";

describe("toHttpException", () => {
    it.each([
        [new MediaNotFound("gone"), NotFoundException, 404],
        [new MediaConflict("busy"), ConflictException, 409],
        [new MediaForbidden("no"), ForbiddenException, 403],
    ] as const)("%p → %p", (error, type, status) => {
        const http = toHttpException(error);
        expect(http).toBeInstanceOf(type);
        expect(http.getStatus()).toBe(status);
        expect(http.message).toBe(error.message);
    });
});

describe("withHttpErrors / rethrowAsHttp", () => {
    it("maps domain errors", async () => {
        await expect(
            withHttpErrors(() => Promise.reject(new MediaConflict("busy"))),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it("passes store and provider errors through unchanged (a 500)", async () => {
        const race = new OpenSessionConflict(new Error("duplicate key"));
        await expect(withHttpErrors(() => Promise.reject(race))).rejects.toBe(
            race,
        );
        expect(race.message).toBe("duplicate key");
        const boom = new Error("livekit down");
        expect(() => rethrowAsHttp(boom)).toThrow(boom);
    });
});
