import { PARTICIPANT_GRANTS } from "../../domain/media-session.js";
import { MESSAGES, MediaConflict, MediaNotFound } from "../../domain/errors.js";
import type {
    ParticipantTokenPort,
    RoomAccessPort,
} from "../ports/collaborators.port.js";
import type { MediaSessionRecords } from "./session-records.js";

/** What a member needs to join the room's LiveKit room. */
export interface MediaConnection {
    mediaSessionId: string;
    participantId: string;
    serverUrl: string;
    participantToken: string;
}

/**
 * Issues connection credentials for an ACTIVE session to an active member.
 * The token identity is the membership id, so it dies with the membership.
 */
export class IssueMediaConnection {
    constructor(
        private readonly records: MediaSessionRecords,
        private readonly rooms: RoomAccessPort,
        private readonly tokens: ParticipantTokenPort,
    ) {}

    async execute(
        mediaSessionId: string,
        userId: string,
    ): Promise<MediaConnection> {
        const session = await this.records.get(mediaSessionId);

        if (session.status !== "ACTIVE") {
            throw new MediaConflict(MESSAGES.cannotConnect(session.status));
        }

        const participant = await this.rooms.findActiveParticipant(
            session.roomId,
            userId,
        );

        if (!participant) {
            throw new MediaNotFound(MESSAGES.notParticipant);
        }

        const participantId = participant.participant_id;

        const participantToken = await this.tokens.createParticipantToken({
            roomName: session.id,
            participantIdentity: participantId,
            ...PARTICIPANT_GRANTS,
        });

        return {
            mediaSessionId: session.id,
            participantId,
            serverUrl: this.tokens.serverUrl,
            participantToken,
        };
    }
}
