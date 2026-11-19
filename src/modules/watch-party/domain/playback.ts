import { PlaybackNotPermitted } from "./errors.js";

export type PlaybackAction = "PLAY" | "PAUSE" | "SEEK";

export interface PlaybackState {
    playhead: number;
    status: "PLAYING" | "PAUSED";
    lastUpdated: number;
}

export function initialPlaybackState(now: number): PlaybackState {
    return { playhead: 0, status: "PAUSED", lastUpdated: now };
}

/**
 * Owner-only playback control. PLAY and PAUSE set the status; SEEK keeps it.
 * The playhead is taken as given: no range or NaN check (pinned by
 * watch-room.actor.spec.ts; adding validation is a deliberate change).
 */
export function applyPlaybackCommand(
    current: PlaybackState,
    command: {
        requestingId: string;
        ownerId: string;
        action: PlaybackAction;
        targetPlayhead: number;
        now: number;
    },
): PlaybackState {
    if (command.requestingId !== command.ownerId) {
        throw new PlaybackNotPermitted();
    }

    return {
        playhead: command.targetPlayhead,
        status:
            command.action === "PLAY"
                ? "PLAYING"
                : command.action === "PAUSE"
                  ? "PAUSED"
                  : current.status,
        lastUpdated: command.now,
    };
}
