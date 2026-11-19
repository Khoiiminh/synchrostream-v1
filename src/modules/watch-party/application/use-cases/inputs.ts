/*
 * Plain inputs of the use cases. The validated request DTOs in
 * presentation/dto satisfy them structurally; the application layer does not
 * depend on validation decorators.
 */

export interface CreateRoomInput {
    /** Optional explicit code; normalized (trimmed, upper-cased). */
    roomCode?: string;
    passwordPlain: string;
    movieId: string;
    /** Defaults to 5. */
    maxParticipants?: number;
}

export interface JoinRoomInput {
    roomCode: string;
    passwordPlain: string;
}
