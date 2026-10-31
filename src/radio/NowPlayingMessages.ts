// Mensajes de texto de cada sesion: los avisos (reconexion, inactividad) y el
// mensaje persistente "sonando ahora", que se edita en vez de enviar uno nuevo
// con cada cancion.
import type {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  Client,
  EmbedBuilder,
  Message,
} from "discord.js";
import { errorMessage } from "../errors";
import { logger } from "../logger";
import { loadStationLogo, type Artwork } from "./artwork";
import type { MetadataTracker } from "./MetadataTracker";
import {
  buildNowPlayingPayload,
  buildStoppedPayload,
  type EmbedPayload,
  type Station,
} from "./nowPlayingView";
import { sessionContext, type GuildSession, type SessionStatus } from "./session";

// Espera antes de editar: agrupa cambios que llegan casi juntos.
const NOW_PLAYING_DEBOUNCE_MS = 300;

type SendableChannel = {
  send: (options: {
    content?: string;
    embeds?: EmbedBuilder[];
    files?: AttachmentBuilder[];
    components?: ActionRowBuilder<ButtonBuilder>[];
    allowedMentions?: { parse: never[] };
  }) => Promise<Message>;
};

// Datos que el mensaje necesita de la radio y de las sesiones.
export type NowPlayingContext = {
  station(): Station;
  statusOf(session: GuildSession): SessionStatus;
  listenerCount(session: GuildSession): Promise<number>;
};

export class NowPlayingMessages {
  private stationLogoPromise?: Promise<Artwork | null>;

  constructor(
    private readonly client: Client,
    private readonly metadata: MetadataTracker,
    private readonly context: NowPlayingContext,
  ) {}

  public async sendText(session: GuildSession, content: string): Promise<void> {
    const channel = await this.getSendableChannel(session.textChannelId);
    if (!channel) return;
    await channel.send({ content, allowedMentions: { parse: [] } }).catch((error: unknown) => {
      logger.warn("text.send_failed", { ...sessionContext(session), error: errorMessage(error) });
    });
  }

  // Aviso de texto a todas las sesiones activas.
  public async sendToAll(all: Iterable<GuildSession>, content: string): Promise<void> {
    const sessions = [...all].filter((session) => !session.stopping);
    await Promise.all(sessions.map((session) => this.sendText(session, content)));
  }

  public scheduleUpdate(session: GuildSession): void {
    if (!session.nowPlayingMessage || session.stopping || session.nowPlayingUpdateTimer) return;
    session.nowPlayingUpdateTimer = setTimeout(() => {
      session.nowPlayingUpdateTimer = undefined;
      void this.publish(session, false);
    }, NOW_PLAYING_DEBOUNCE_MS);
  }

  public async publish(session: GuildSession, create: boolean): Promise<void> {
    const metadataUpdatedAt = this.metadata.updatedAt;
    const revision = ++session.nowPlayingRevision;
    const payload = await this.build(session);
    // Descargar la portada puede tardar: si mientras tanto empezo otra
    // actualizacion, esta ya esta obsoleta y no debe pisar a la nueva.
    if (revision !== session.nowPlayingRevision || session.stopping) return;
    if (session.nowPlayingMessage) {
      await session.nowPlayingMessage
        .edit({ ...payload, attachments: [] })
        .catch((error: unknown) => {
          logger.warn("now_playing.edit_failed", {
            ...sessionContext(session),
            error: errorMessage(error),
          });
          session.nowPlayingMessage = undefined;
        });
      return;
    }
    if (!create) return;
    const channel = await this.getSendableChannel(session.textChannelId);
    if (!channel) return;
    session.nowPlayingMessage = await channel
      .send({ ...payload, allowedMentions: { parse: [] } })
      .catch(() => undefined);
    if (session.nowPlayingMessage && this.metadata.updatedAt !== metadataUpdatedAt) {
      this.scheduleUpdate(session);
    }
  }

  public async build(session: GuildSession): Promise<EmbedPayload> {
    const song = this.metadata.song;
    const extras = this.metadata.extras;
    const [listeners, cover, logo] = await Promise.all([
      this.context.listenerCount(session),
      this.metadata.cover(true),
      this.stationLogo(),
    ]);
    return buildNowPlayingPayload({
      station: this.context.station(),
      status: this.context.statusOf(session),
      song,
      extras,
      listeners,
      voiceChannelId: session.voiceChannelId,
      cover,
      logo,
    });
  }

  public async markStopped(session: GuildSession, reason: string): Promise<void> {
    if (!session.nowPlayingMessage) return;
    // Sin descarga: no retrasamos la desconexion esperando a la red.
    const [cover, logo] = await Promise.all([this.metadata.cover(false), this.stationLogo()]);
    const payload = buildStoppedPayload(
      this.context.station(),
      reason,
      this.metadata.song,
      cover,
      logo,
    );
    await session.nowPlayingMessage.edit({ ...payload, attachments: [] }).catch(() => null);
  }

  private async getSendableChannel(channelId: string): Promise<SendableChannel | null> {
    const channel =
      this.client.channels.cache.get(channelId) ??
      (await this.client.channels.fetch(channelId).catch(() => null));
    if (!channel || !("send" in channel) || typeof channel.send !== "function") return null;
    return channel;
  }

  private stationLogo(): Promise<Artwork | null> {
    this.stationLogoPromise ??= loadStationLogo();
    return this.stationLogoPromise;
  }
}
