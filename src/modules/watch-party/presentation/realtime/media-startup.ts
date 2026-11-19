import type { RealtimeContext } from "./realtime-context.js";

/** Background LiveKit session startup per room; never gates watch-room admission. */
export class MediaStartup {
    constructor(private readonly ctx: RealtimeContext) {}

    /**
     * Ensures the room has an ACTIVE LiveKit media session without blocking
     * watch-room admission. Retries with capped backoff while the room actor is
     * alive and the room is ACTIVE, then pushes the session id to every member.
     */
    ensureMediaSession(roomId: string): void {
        if (this.ctx.registry.mediaSessionStartups.has(roomId)) return;

        const startup = (async () => {
            for (let attempt = 0; ; attempt += 1) {
                if (!this.ctx.registry.runningActors.has(roomId)) return;

                try {
                    const mediaSession =
                        await this.ctx.liveKitService.getOrCreateMediaSession(
                            roomId,
                        );
                    const actor = this.ctx.registry.runningActors.get(roomId);
                    if (!actor) return;

                    if (actor.mediaSessionId !== mediaSession.id) {
                        actor.setMediaSessionId(mediaSession.id);
                        this.ctx.server
                            .to(roomId)
                            .emit("room:state_update", actor.getSnapshot());
                    }
                    return;
                } catch (error) {
                    try {
                        await this.ctx.watchPartyService.assertRoomActive(
                            roomId,
                        );
                    } catch {
                        // Termination owns provider cleanup; stop trying to start media.
                        return;
                    }

                    const delayMs = Math.min(
                        30_000,
                        1_000 * 2 ** Math.min(attempt, 5),
                    );
                    this.ctx.logger.warn({
                        message:
                            "LiveKit media session not ready; watch room stays available and startup will be retried",
                        roomId,
                        attempt: attempt + 1,
                        retryInMs: delayMs,
                        err: error,
                    });
                    await new Promise((resolve) =>
                        setTimeout(resolve, delayMs),
                    );
                }
            }
        })()
            .catch((error: unknown) => {
                this.ctx.logger.error({
                    message: "LiveKit media session startup loop failed",
                    roomId,
                    err: error,
                });
            })
            .finally(() => {
                this.ctx.registry.mediaSessionStartups.delete(roomId);
            });

        this.ctx.registry.mediaSessionStartups.set(roomId, startup);
    }
}
