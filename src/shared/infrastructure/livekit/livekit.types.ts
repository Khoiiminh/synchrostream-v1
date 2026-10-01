export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export const LIVEKIT_CONFIG = Symbol('LIVEKIT_CONFIG');

export interface CreateLiveKitTokenOptions {
  roomName: string;
  participantIdentity: string;
  participantName?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  ttl?: string | number;
}