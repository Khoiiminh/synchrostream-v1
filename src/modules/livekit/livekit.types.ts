/** Row shape of the active-participant lookup used to mint LiveKit tokens. */
export interface ActiveParticipantRow {
    participant_id: string;
    user_id: string;
    room_id: string;
}

/** Row shape of the active-room lookup used before LiveKit startup. */
export interface ActiveRoomRow {
    id: string;
    max_participants: number;
}
