export type MediaSessionStatus = 
    | 'CREATED'
    | 'STARTING'
    | 'ACTIVE'
    | 'ENDING'
    | 'ENDED';

export interface MediaSession {
    id: string;
    roomId: string;
    status: MediaSessionStatus;
    assignedSfuNodeId: string | null;
    createdAt: Date;
    startedAt: Date | null;
    endedAt: Date | null;
}