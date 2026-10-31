import type { PlayerSubscription, VoiceConnection } from "@discordjs/voice";
import type { Message } from "discord.js";
import type { BroadcastStatus } from "./Broadcast";

export type SessionStatus = "connecting" | "playing" | "reconnecting" | "stopping" | "stopped";

// Una sesion por servidor: solo su conexion de voz y su mensaje. El stream,
// el reproductor y la metadata son compartidos por todas las sesiones.
export type GuildSession = {
  id: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  createdAt: number;
  // Estado de la conexion de voz; el estado visible combina este con el del stream.
  status: SessionStatus;
  connection: VoiceConnection;
  subscription?: PlayerSubscription;
  idleTimer?: NodeJS.Timeout;
  idleGeneration: number;
  idleRefreshRequested: boolean;
  idleRefreshPromise?: Promise<void>;
  voiceRecoveryPromise?: Promise<void>;
  stopPromise?: Promise<void>;
  totalRetries: number;
  lastError: string | null;
  nowPlayingMessage?: Message;
  nowPlayingUpdateTimer?: NodeJS.Timeout;
  nowPlayingRevision: number;
  stopping: boolean;
};

export function sessionContext(session: GuildSession): Record<string, unknown> {
  return {
    sessionId: session.id,
    guildId: session.guildId,
    voiceChannelId: session.voiceChannelId,
    status: session.status,
  };
}

// Estado visible de una sesion: combina su conexion de voz con el del stream
// compartido (si la voz esta lista pero el stream reconecta, se muestra eso).
export function effectiveStatus(
  session: GuildSession,
  broadcastStatus: BroadcastStatus,
): SessionStatus {
  if (session.status !== "playing") return session.status;
  if (broadcastStatus === "playing") return "playing";
  return broadcastStatus === "reconnecting" ? "reconnecting" : "connecting";
}
