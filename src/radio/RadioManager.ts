import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ActivityType,
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  GuildMember,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Message,
  type VoiceState,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { PassThrough, Transform, type TransformCallback } from "node:stream";
import type { Readable } from "node:stream";
import { logger } from "../logger";

const STREAM_OPEN_TIMEOUT_MS = 20_000;
const PLAYER_START_TIMEOUT_MS = 20_000;
const CONNECTION_READY_TIMEOUT_MS = 20_000;
const STREAM_STALL_TIMEOUT_MS = 45_000;
const STREAM_WATCHDOG_INTERVAL_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_START_ATTEMPTS = 5;
const AUDIO_HIGH_WATER_MARK = 128 * 1024;
const PRESENCE_UPDATE_INTERVAL_MS = 10_000;
const ARTWORK_DOWNLOAD_TIMEOUT_MS = 8_000;
const ARTWORK_DOWNLOAD_ATTEMPTS = 2;
const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;
const FALLBACK_ARTWORK_PATH = path.resolve(__dirname, "../../img/icon-512.png");
const ARTWORK_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

type SessionStatus =
  | "connecting"
  | "playing"
  | "reconnecting"
  | "stopping"
  | "stopped";

type MetadataSource = "icy" | "json" | null;

type IcyHandle = {
  req: http.ClientRequest;
  res: IncomingMessage;
  audioStream: Readable;
  demuxer: IcyDemuxer | null;
};

export type Artwork = {
  url: string | null;
  data: Buffer;
  fileName: string;
};

type GuildSession = {
  id: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  streamUrl: string;
  createdAt: number;
  playbackStartedAt: number | null;
  status: SessionStatus;
  connection: VoiceConnection;
  player: AudioPlayer;
  icy?: IcyHandle;
  streamGeneration: number;
  currentTitle: string | null;
  currentArtworkUrl: string | null;
  artwork?: Artwork;
  stationName: string;
  metadataSource: MetadataSource;
  metadataUpdatedAt: number;
  metadataTimer?: NodeJS.Timeout;
  watchdogTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  idleGeneration: number;
  idleRefreshRequested: boolean;
  idleRefreshPromise?: Promise<void>;
  recoveryPromise?: Promise<void>;
  stopPromise?: Promise<void>;
  consecutiveFailures: number;
  totalRetries: number;
  lastError: string | null;
  lastAudioAt: number | null;
  nowPlayingMessage?: Message;
  nowPlayingUpdateTimer?: NodeJS.Timeout;
  nowPlayingRevision: number;
  stopping: boolean;
};

type SendableChannel = {
  send: (options: {
    content?: string;
    embeds?: EmbedBuilder[];
    files?: AttachmentBuilder[];
    allowedMentions?: { parse: never[] };
  }) => Promise<Message>;
};

type EmbedPayload = {
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
};

export type RadioManagerConfig = {
  streamUrl: string;
  stationName: string | null;
  idleDisconnectMinutes: number;
  metadataUrl: string | null;
  metadataTitlePath: string | null;
  metadataArtistPath: string | null;
  metadataArtworkPath: string | null;
  metadataPollSeconds: number;
};

export type RadioMetrics = {
  sessions: number;
  playingSessions: number;
  reconnectingSessions: number;
  streamFailures: number;
  totalRetries: number;
  metadataUpdates: number;
  commands: Record<string, number>;
};

function sessionContext(session: GuildSession): Record<string, unknown> {
  return {
    sessionId: session.id,
    guildId: session.guildId,
    voiceChannelId: session.voiceChannelId,
    status: session.status,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

export function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function firstString(value: unknown, paths: string[]): { value: string; path: string } | null {
  for (const path of paths) {
    const candidate = readPath(value, path);
    if (typeof candidate === "string" && candidate.trim()) {
      return { value: candidate.trim(), path };
    }
  }
  return null;
}

export function extractMetadataTitle(
  payload: unknown,
  titlePath: string | null,
  artistPath: string | null,
): string | null {
  const titlePaths = [
    ...(titlePath ? [titlePath] : []),
    "now_playing.song.title",
    "song.title",
    "current.title",
    "data.title",
    "title",
    "now_playing.song.text",
    "currentSong",
    "StreamTitle",
  ];
  const artistPaths = [
    ...(artistPath ? [artistPath] : []),
    "now_playing.song.artist",
    "song.artist",
    "current.artist",
    "data.artist",
    "artist",
  ];
  const title = firstString(payload, titlePaths);
  if (!title) return null;
  const artist = firstString(payload, artistPaths);
  if (!artist || title.value.toLocaleLowerCase().includes(artist.value.toLocaleLowerCase())) {
    return title.value;
  }
  return `${artist.value} — ${title.value}`;
}

export function extractMetadataArtwork(
  payload: unknown,
  artworkPath: string | null,
): string | null {
  const artwork = firstString(payload, [
    ...(artworkPath ? [artworkPath] : []),
    "now_playing.song.art",
    "song.art",
    "current.art",
    "data.art",
    "art",
    "artwork",
    "cover",
  ]);
  if (!artwork) return null;
  try {
    const url = new URL(artwork.value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function downloadArtwork(
  url: string,
  timeoutMs = ARTWORK_DOWNLOAD_TIMEOUT_MS,
): Promise<Artwork> {
  const response = await fetch(url, {
    headers: { Accept: "image/*", "User-Agent": "monkey-bot/0.2" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = ARTWORK_EXTENSIONS[contentType];
  if (!extension) throw new Error(`Tipo de contenido no soportado: ${contentType || "desconocido"}`);
  if (Number(response.headers.get("content-length")) > MAX_ARTWORK_BYTES) {
    throw new Error("La portada supera el tamano maximo");
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length === 0) throw new Error("La portada esta vacia");
  if (data.length > MAX_ARTWORK_BYTES) throw new Error("La portada supera el tamano maximo");
  return { url, data, fileName: `cover.${extension}` };
}

export function inferAzuraCastMetadataUrl(streamUrl: string): string | null {
  try {
    const url = new URL(streamUrl);
    const match = url.pathname.match(/^\/listen\/([^/]+)\//);
    if (!match?.[1]) return null;
    return new URL(`/api/nowplaying/${match[1]}`, url.origin).toString();
  } catch {
    return null;
  }
}

export function parseIcyMetadata(metadata: Buffer): string | null {
  let text = metadata.toString("utf8");
  if (text.includes("�")) text = metadata.toString("latin1");
  text = text.replace(/\0/g, "");
  const marker = "StreamTitle='";
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  const end = text.indexOf("';", valueStart);
  const title = text.slice(valueStart, end >= 0 ? end : undefined).trim();
  return title || null;
}

export class IcyDemuxer extends Transform {
  private remainingAudio: number;
  private expectingMetadataLength = false;
  private remainingMetadata = 0;
  private metadataParts: Buffer[] = [];

  constructor(private readonly metaint: number) {
    super({ highWaterMark: AUDIO_HIGH_WATER_MARK });
    if (!Number.isInteger(metaint) || metaint <= 0) {
      throw new Error("metaint ICY invalido");
    }
    this.remainingAudio = metaint;
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remainingAudio > 0) {
          const length = Math.min(this.remainingAudio, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + length));
          offset += length;
          this.remainingAudio -= length;
          if (this.remainingAudio === 0) this.expectingMetadataLength = true;
          continue;
        }

        if (this.expectingMetadataLength) {
          this.remainingMetadata = chunk[offset] * 16;
          offset += 1;
          this.expectingMetadataLength = false;
          if (this.remainingMetadata === 0) this.remainingAudio = this.metaint;
          else this.metadataParts = [];
          continue;
        }

        const length = Math.min(this.remainingMetadata, chunk.length - offset);
        this.metadataParts.push(chunk.subarray(offset, offset + length));
        offset += length;
        this.remainingMetadata -= length;
        if (this.remainingMetadata === 0) {
          this.emit("metadata", Buffer.concat(this.metadataParts));
          this.metadataParts = [];
          this.remainingAudio = this.metaint;
        }
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

export class RadioManager {
  private readonly sessions = new Map<string, GuildSession>();
  private readonly commandCounts = new Map<string, number>();
  private streamFailures = 0;
  private totalRetries = 0;
  private metadataUpdates = 0;
  private pendingPresenceTitle: string | null = null;
  private publishedPresenceTitle: string | null = null;
  private lastPresenceAt = 0;
  private presenceTimer?: NodeJS.Timeout;
  private fallbackArtworkPromise?: Promise<Artwork | null>;
  private readonly metadataUrl: string | null;

  constructor(
    private readonly client: Client,
    private readonly config: RadioManagerConfig,
  ) {
    this.metadataUrl = config.metadataUrl ?? inferAzuraCastMetadataUrl(config.streamUrl);
  }

  public recordCommand(command: string): void {
    this.commandCounts.set(command, (this.commandCounts.get(command) ?? 0) + 1);
  }

  public getMetrics(): RadioMetrics {
    const sessions = [...this.sessions.values()];
    return {
      sessions: sessions.length,
      playingSessions: sessions.filter((session) => session.status === "playing").length,
      reconnectingSessions: sessions.filter((session) => session.status === "reconnecting").length,
      streamFailures: this.streamFailures,
      totalRetries: this.totalRetries,
      metadataUpdates: this.metadataUpdates,
      commands: Object.fromEntries(this.commandCounts),
    };
  }

  public async play(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.defer(interaction))) return;
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply("Este comando solo funciona dentro de un servidor.");
      return;
    }

    const member = await this.resolveMember(interaction);
    const voiceChannel = member?.voice.channel;
    if (!member || !voiceChannel) {
      await interaction.editReply("Primero entra a un canal de voz y luego usa `/play`.");
      return;
    }
    if (voiceChannel.type === ChannelType.GuildStageVoice) {
      await interaction.editReply(
        "Los canales Stage no estan habilitados: usa un canal de voz normal.",
      );
      return;
    }
    if (voiceChannel.type !== ChannelType.GuildVoice) {
      await interaction.editReply("Ese canal no es compatible con la radio.");
      return;
    }

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const permissions = me ? voiceChannel.permissionsFor(me) : null;
    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.Connect) ||
      !permissions.has(PermissionFlagsBits.Speak)
    ) {
      await interaction.editReply(
        "Necesito permisos para **Ver**, **Conectar** y **Hablar** en ese canal.",
      );
      return;
    }

    let existing = this.sessions.get(guild.id);
    if (existing?.stopping && existing.stopPromise) {
      await existing.stopPromise;
      existing = this.sessions.get(guild.id);
    }
    if (existing && !existing.stopping) {
      if (existing.voiceChannelId === voiceChannel.id) {
        existing.textChannelId = interaction.channelId;
        await interaction.editReply(
          existing.status === "playing"
            ? `Ya estoy reproduciendo en **${voiceChannel.name}**.`
            : `La sesion de **${voiceChannel.name}** esta ${this.statusLabel(existing.status).toLowerCase()}.`,
        );
        await this.publishPersistentNowPlaying(existing, true);
        this.requestIdleRefresh(existing);
        return;
      }

      if (existing.voiceChannelId !== voiceChannel.id) {
        const listenerCount = await this.humanListenerCount(existing);
        const canMove = member.permissions.has(PermissionFlagsBits.MoveMembers);
        if (listenerCount > 0 && !canMove) {
          await interaction.editReply(
            `Ya estoy reproduciendo en <#${existing.voiceChannelId}>. ` +
              "Necesitas **Mover miembros** para trasladarme mientras haya oyentes.",
          );
          return;
        }
      }

      await this.stopSession(existing, "replaced");
    }

    await interaction.editReply(`Conectando a **${voiceChannel.name}**...`);
    const session = this.createSession({
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      adapterCreator: guild.voiceAdapterCreator,
    });

    try {
      await this.ensurePlayback(session, "initial_start", true);
      if (this.sessions.get(guild.id) !== session || session.status !== "playing") {
        throw new Error("La sesion termino antes de iniciar la reproduccion");
      }
      await interaction.editReply(`Reproduciendo **${session.stationName}** en **${voiceChannel.name}**.`);
      await this.publishPersistentNowPlaying(session, true);
      this.requestIdleRefresh(session);
    } catch (error) {
      logger.error("play.failed", { ...sessionContext(session), error: errorMessage(error) });
      await interaction.editReply(`No pude iniciar la radio: ${errorMessage(error)}`).catch(() => null);
    }
  }

  public async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: "Este comando solo funciona en un servidor.", ephemeral: true });
      return;
    }
    const session = this.sessions.get(guild.id);
    if (!session || session.stopping) {
      await interaction.reply({ content: "No hay una radio activa en este servidor.", ephemeral: true });
      return;
    }
    const member = await this.resolveMember(interaction);
    const sameChannel = member?.voice.channelId === session.voiceChannelId;
    const canMove = member?.permissions.has(PermissionFlagsBits.MoveMembers) ?? false;
    if (!sameChannel && !canMove) {
      await interaction.reply({
        content: "Debes estar en mi canal de voz o tener **Mover miembros** para detenerme.",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply();
    await this.stopSession(session, "command");
    await interaction.editReply("Radio detenida. Hasta pronto.");
  }

  public async nowPlaying(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = interaction.guildId ? this.sessions.get(interaction.guildId) : undefined;
    if (!session || session.stopping) {
      await interaction.reply({ content: "No hay una radio activa en este servidor.", ephemeral: true });
      return;
    }
    if (!(await this.defer(interaction))) return;
    await interaction.editReply(await this.buildNowPlayingPayload(session));
  }

  public async status(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = interaction.guildId ? this.sessions.get(interaction.guildId) : undefined;
    if (!session || session.stopping) {
      await interaction.reply({ content: "No hay una radio activa en este servidor.", ephemeral: true });
      return;
    }
    const listeners = await this.humanListenerCount(session);
    const uptimeMs = Date.now() - session.createdAt;
    const ping = session.connection.ping;
    const embed = new EmbedBuilder()
      .setColor(session.status === "playing" ? 0x2ecc71 : 0xf39c12)
      .setTitle(`Estado — ${session.stationName}`)
      .addFields(
        { name: "Estado", value: this.statusLabel(session.status), inline: true },
        { name: "Canal", value: `<#${session.voiceChannelId}>`, inline: true },
        { name: "Oyentes", value: String(listeners), inline: true },
        { name: "Uptime", value: this.formatDuration(uptimeMs), inline: true },
        { name: "Ping voz", value: `WS ${ping.ws ?? "—"} ms / UDP ${ping.udp ?? "—"} ms`, inline: true },
        { name: "Reintentos", value: String(session.totalRetries), inline: true },
        { name: "Metadata", value: session.metadataSource?.toUpperCase() ?? "No disponible", inline: true },
        { name: "Ultimo audio", value: session.lastAudioAt ? `<t:${Math.floor(session.lastAudioAt / 1000)}:R>` : "—", inline: true },
      )
      .setTimestamp();
    if (session.lastError) embed.addFields({ name: "Ultimo error", value: session.lastError.slice(0, 1024) });
    await interaction.reply({ embeds: [embed] });
  }

  public onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const session = this.sessions.get(newState.guild.id);
    if (!session || session.stopping) return;
    if (
      newState.id === this.client.user?.id &&
      oldState.channelId === session.voiceChannelId &&
      newState.channelId !== session.voiceChannelId
    ) {
      logger.info("voice.bot_removed", {
        ...sessionContext(session),
        nextVoiceChannelId: newState.channelId,
      });
      void this.stopSession(session, "manual_disconnect");
      return;
    }
    if (
      oldState.channelId === session.voiceChannelId ||
      newState.channelId === session.voiceChannelId
    ) {
      this.requestIdleRefresh(session);
    }
  }

  public async shutdown(): Promise<void> {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    await Promise.all([...this.sessions.values()].map((session) => this.stopSession(session, "shutdown")));
  }

  private async defer(interaction: ChatInputCommandInteraction): Promise<boolean> {
    try {
      await interaction.deferReply();
      return true;
    } catch (error) {
      logger.warn("interaction.defer_failed", {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        error: errorMessage(error),
      });
      return false;
    }
  }

  private async resolveMember(interaction: ChatInputCommandInteraction): Promise<GuildMember | null> {
    if (!interaction.guild) return null;
    if (interaction.member instanceof GuildMember) return interaction.member;
    return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  }

  private createSession(params: {
    guildId: string;
    voiceChannelId: string;
    textChannelId: string;
    adapterCreator: DiscordGatewayAdapterCreator;
  }): GuildSession {
    const connection = joinVoiceChannel({
      channelId: params.voiceChannelId,
      guildId: params.guildId,
      adapterCreator: params.adapterCreator,
      selfDeaf: true,
    });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    connection.subscribe(player);

    const session: GuildSession = {
      id: randomUUID(),
      guildId: params.guildId,
      voiceChannelId: params.voiceChannelId,
      textChannelId: params.textChannelId,
      streamUrl: this.config.streamUrl,
      createdAt: Date.now(),
      playbackStartedAt: null,
      status: "connecting",
      connection,
      player,
      streamGeneration: 0,
      currentTitle: null,
      currentArtworkUrl: null,
      stationName: this.config.stationName ?? "Radio",
      metadataSource: null,
      metadataUpdatedAt: 0,
      idleGeneration: 0,
      idleRefreshRequested: false,
      consecutiveFailures: 0,
      totalRetries: 0,
      lastError: null,
      lastAudioAt: null,
      nowPlayingRevision: 0,
      stopping: false,
    };
    this.sessions.set(params.guildId, session);
    this.attachConnectionEvents(session);
    this.attachPlayerEvents(session);
    logger.info("session.created", sessionContext(session));
    return session;
  }

  private attachConnectionEvents(session: GuildSession): void {
    session.connection.on("stateChange", (oldState, newState) => {
      logger.info("voice.state_changed", {
        ...sessionContext(session),
        previousState: oldState.status,
        nextState: newState.status,
      });
      if (session.stopping || this.sessions.get(session.guildId) !== session) return;
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        void this.stopSession(session, "connection_destroyed");
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        queueMicrotask(() => {
          if (session.stopping || this.sessions.get(session.guildId) !== session) return;
          const guild = this.client.guilds.cache.get(session.guildId);
          const botId = this.client.user?.id;
          const botChannelId = botId ? guild?.voiceStates.cache.get(botId)?.channelId : undefined;
          if (session.status === "playing" && botChannelId !== session.voiceChannelId) {
            void this.stopSession(session, "manual_disconnect");
            return;
          }
          void this.ensurePlayback(session, "voice_disconnected", false).catch(() => null);
        });
      }
    });
    session.connection.on("error", (error) => {
      logger.error("voice.error", { ...sessionContext(session), error: error.message });
    });
  }

  private attachPlayerEvents(session: GuildSession): void {
    session.player.on("error", (error) => {
      this.requestRecovery(session, `Error del reproductor: ${error.message}`);
    });
    session.player.on("stateChange", (oldState, newState) => {
      logger.info("player.state_changed", {
        ...sessionContext(session),
        previousState: oldState.status,
        nextState: newState.status,
      });
      if (
        !session.stopping &&
        oldState.status !== AudioPlayerStatus.Idle &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        this.requestRecovery(session, "El stream termino o dejo de entregar audio");
      }
    });
  }

  private requestRecovery(session: GuildSession, reason: string): void {
    if (session.stopping || this.sessions.get(session.guildId) !== session) return;
    if (session.recoveryPromise) return;
    this.streamFailures += 1;
    session.lastError = reason;
    logger.warn("stream.failure", { ...sessionContext(session), reason });
    void this.ensurePlayback(session, reason, false).catch((error) => {
      logger.error("stream.recovery_failed", {
        ...sessionContext(session),
        error: errorMessage(error),
      });
    });
  }

  private async ensurePlayback(
    session: GuildSession,
    reason: string,
    initial: boolean,
  ): Promise<void> {
    if (session.recoveryPromise) return session.recoveryPromise;
    const recovery = this.recoverSession(session, reason, initial);
    session.recoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (session.recoveryPromise === recovery) {
        session.recoveryPromise = undefined;
        if (
          !session.stopping &&
          session.status === "playing" &&
          session.player.state.status === AudioPlayerStatus.Idle
        ) {
          this.requestRecovery(session, "El stream termino inmediatamente despues de iniciar");
        }
      }
    }
  }

  private async recoverSession(session: GuildSession, reason: string, initial: boolean): Promise<void> {
    let lastError = reason;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      if (session.stopping || this.sessions.get(session.guildId) !== session) {
        throw new Error("La sesion ya no esta activa");
      }
      if (attempt > 1 || !initial) {
        session.status = "reconnecting";
        session.totalRetries += 1;
        this.totalRetries += 1;
        const delayMs = Math.min(30_000, 1_500 * 2 ** Math.min(attempt - 1, 4));
        const jitterMs = Math.floor(Math.random() * 750);
        await this.sendText(
          session,
          `La radio perdio la conexion. Reintentando (${attempt}/${MAX_START_ATTEMPTS})...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs + jitterMs));
      } else {
        session.status = "connecting";
      }

      try {
        await this.ensureConnectionReady(session);
        await this.startStream(session);
        session.status = "playing";
        session.playbackStartedAt = Date.now();
        session.consecutiveFailures = 0;
        session.lastError = null;
        logger.info("stream.playing", { ...sessionContext(session), attempt });
        this.schedulePersistentNowPlayingUpdate(session);
        return;
      } catch (error) {
        lastError = errorMessage(error);
        session.lastError = lastError;
        session.consecutiveFailures += 1;
        logger.warn("stream.start_attempt_failed", {
          ...sessionContext(session),
          attempt,
          error: lastError,
        });
        this.closeStream(session);
      }
    }

    await this.sendText(session, "No pude mantener la radio activa y me desconectare.");
    await this.stopSession(session, "retries_exhausted");
    throw new Error(lastError);
  }

  private async ensureConnectionReady(session: GuildSession): Promise<void> {
    if (this.connectionIsDestroyed(session.connection)) {
      throw new Error("La conexion de voz fue destruida");
    }
    if (session.connection.state.status === VoiceConnectionStatus.Ready) return;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (
        session.connection.state.status === VoiceConnectionStatus.Disconnected ||
        attempt > 1
      ) {
        const accepted = session.connection.rejoin();
        if (!accepted) throw new Error("Discord rechazo el reingreso al canal de voz");
      }
      try {
        await entersState(
          session.connection,
          VoiceConnectionStatus.Ready,
          CONNECTION_READY_TIMEOUT_MS,
        );
        return;
      } catch {
        if (this.connectionIsDestroyed(session.connection)) break;
      }
    }
    throw new Error("Timeout esperando la conexion de voz");
  }

  private async startStream(session: GuildSession): Promise<void> {
    this.closeStream(session);
    const generation = ++session.streamGeneration;
    const handle = await this.openIcyStream(session.streamUrl);
    if (session.stopping || generation !== session.streamGeneration) {
      handle.req.destroy();
      handle.res.destroy();
      handle.audioStream.destroy();
      throw new Error("El inicio del stream fue reemplazado");
    }
    session.icy = handle;
    session.lastAudioAt = Date.now();
    session.stationName =
      this.config.stationName ??
      headerValue(handle.res.headers["icy-name"]) ??
      "Radio";

    if (handle.demuxer) {
      handle.demuxer.on("metadata", (metadata: Buffer) => {
        if (generation !== session.streamGeneration || session.stopping) return;
        try {
          const title = parseIcyMetadata(metadata);
          if (title) this.handleMetadata(session, title, "icy");
        } catch (error) {
          logger.warn("metadata.icy_parse_failed", {
            ...sessionContext(session),
            error: errorMessage(error),
          });
        }
      });
    }

    if (this.metadataUrl) this.startMetadataPolling(session, generation);

    const passThrough = new PassThrough({ highWaterMark: AUDIO_HIGH_WATER_MARK });
    passThrough.on("data", () => {
      if (generation === session.streamGeneration) session.lastAudioAt = Date.now();
    });
    const fail = (error: Error) => {
      if (generation !== session.streamGeneration || session.stopping) return;
      passThrough.destroy(error);
      this.requestRecovery(session, `Fallo del stream HTTP: ${error.message}`);
    };
    handle.audioStream.on("error", fail);
    handle.res.on("aborted", () => fail(new Error("Respuesta HTTP abortada")));
    handle.audioStream.pipe(passThrough);

    session.watchdogTimer = setInterval(() => {
      if (
        generation === session.streamGeneration &&
        session.lastAudioAt &&
        Date.now() - session.lastAudioAt > STREAM_STALL_TIMEOUT_MS
      ) {
        fail(new Error("El stream no entrego audio durante 45 segundos"));
      }
    }, STREAM_WATCHDOG_INTERVAL_MS);

    const resource = createAudioResource(passThrough, { inputType: StreamType.Arbitrary });
    session.player.play(resource);
    await entersState(session.player, AudioPlayerStatus.Playing, PLAYER_START_TIMEOUT_MS);
  }

  private startMetadataPolling(session: GuildSession, generation: number): void {
    if (session.metadataTimer) clearInterval(session.metadataTimer);
    const poll = async () => {
      if (session.stopping || generation !== session.streamGeneration || !this.metadataUrl) return;
      try {
        const response = await fetch(this.metadataUrl, {
          headers: { Accept: "application/json", "User-Agent": "monkey-bot/0.2" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        if (body.length > 1_000_000) throw new Error("La respuesta de metadata supera 1 MB");
        const payload: unknown = JSON.parse(body);
        const title = extractMetadataTitle(
          payload,
          this.config.metadataTitlePath,
          this.config.metadataArtistPath,
        );
        const artworkUrl = extractMetadataArtwork(payload, this.config.metadataArtworkPath);
        if (title) this.handleMetadata(session, title, "json", artworkUrl);
      } catch (error) {
        logger.warn("metadata.poll_failed", {
          ...sessionContext(session),
          error: errorMessage(error),
        });
      }
    };
    void poll();
    session.metadataTimer = setInterval(() => void poll(), this.config.metadataPollSeconds * 1000);
  }

  private handleMetadata(
    session: GuildSession,
    rawTitle: string,
    source: Exclude<MetadataSource, null>,
    artworkUrl?: string | null,
  ): void {
    const title = rawTitle.replace(/\0/g, "").trim().slice(0, 300);
    if (!title) return;
    if (
      source === "icy" &&
      session.metadataSource === "json" &&
      Date.now() - session.metadataUpdatedAt < this.config.metadataPollSeconds * 2_000
    ) return;
    const titleChanged = title !== session.currentTitle;
    const artworkChanged = artworkUrl !== undefined && artworkUrl !== session.currentArtworkUrl;
    if (!titleChanged && !artworkChanged && source === session.metadataSource) {
      if (source === "json") session.metadataUpdatedAt = Date.now();
      return;
    }
    session.currentTitle = title;
    if (artworkUrl !== undefined) session.currentArtworkUrl = artworkUrl;
    session.metadataSource = source;
    session.metadataUpdatedAt = Date.now();
    this.metadataUpdates += 1;
    logger.info("metadata.updated", {
      ...sessionContext(session),
      source,
      title,
      hasArtwork: Boolean(session.currentArtworkUrl),
    });
    this.schedulePresence(title);
    this.schedulePersistentNowPlayingUpdate(session);
  }

  private schedulePresence(title: string): void {
    this.pendingPresenceTitle = title;
    const remaining = PRESENCE_UPDATE_INTERVAL_MS - (Date.now() - this.lastPresenceAt);
    if (remaining <= 0) {
      this.flushPresence();
      return;
    }
    if (!this.presenceTimer) {
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = undefined;
        this.flushPresence();
      }, remaining);
    }
  }

  private flushPresence(): void {
    const title = this.pendingPresenceTitle?.trim();
    if (!title || title === this.publishedPresenceTitle) return;
    this.pendingPresenceTitle = null;
    this.publishedPresenceTitle = title;
    this.lastPresenceAt = Date.now();
    this.client.user?.setPresence({
      activities: [{ name: title.slice(0, 128), type: ActivityType.Listening }],
      status: "online",
    });
  }

  private syncPresence(): void {
    const active = [...this.sessions.values()]
      .filter((session) => !session.stopping && session.currentTitle)
      .sort((a, b) => b.metadataUpdatedAt - a.metadataUpdatedAt)[0];
    if (active?.currentTitle) {
      this.schedulePresence(active.currentTitle);
      return;
    }
    this.pendingPresenceTitle = null;
    this.publishedPresenceTitle = null;
    this.client.user?.setPresence({
      activities: [{ name: "dale /play a NEX!", type: ActivityType.Playing }],
      status: "online",
    });
  }

  private requestIdleRefresh(session: GuildSession): void {
    if (session.stopping) return;
    session.idleRefreshRequested = true;
    if (session.idleRefreshPromise) return;
    const task = (async () => {
      while (session.idleRefreshRequested && !session.stopping) {
        session.idleRefreshRequested = false;
        await this.refreshIdleState(session);
      }
    })();
    session.idleRefreshPromise = task;
    void task.finally(() => {
      if (session.idleRefreshPromise === task) session.idleRefreshPromise = undefined;
      if (session.idleRefreshRequested) this.requestIdleRefresh(session);
    });
  }

  private async refreshIdleState(session: GuildSession): Promise<void> {
    const listeners = await this.humanListenerCount(session);
    if (session.stopping || this.sessions.get(session.guildId) !== session) return;
    if (listeners > 0) {
      this.cancelIdleTimer(session);
      return;
    }
    if (session.idleTimer) return;

    const generation = ++session.idleGeneration;
    session.idleTimer = setTimeout(() => {
      if (session.idleGeneration !== generation) return;
      session.idleTimer = undefined;
      void this.disconnectIfStillEmpty(session, generation);
    }, this.config.idleDisconnectMinutes * 60_000);
    void this.sendText(
      session,
      `No hay usuarios escuchando. Me desconectare en ${this.config.idleDisconnectMinutes} min si nadie vuelve.`,
    );
  }

  private cancelIdleTimer(session: GuildSession): void {
    session.idleGeneration += 1;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  private async disconnectIfStillEmpty(session: GuildSession, generation: number): Promise<void> {
    if (session.stopping || session.idleGeneration !== generation) return;
    const listeners = await this.humanListenerCount(session);
    if (listeners > 0) {
      this.cancelIdleTimer(session);
      return;
    }
    await this.sendText(session, "No hay usuarios escuchando. Hasta pronto.");
    await this.stopSession(session, "idle_timeout");
  }

  private async humanListenerCount(session: GuildSession): Promise<number> {
    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) return 0;
    const channel =
      guild.channels.cache.get(session.voiceChannelId) ??
      (await guild.channels.fetch(session.voiceChannelId).catch(() => null));
    if (!channel?.isVoiceBased()) return 0;
    return channel.members.filter((member) => !member.user.bot).size;
  }

  private closeStream(session: GuildSession): void {
    session.streamGeneration += 1;
    if (session.watchdogTimer) clearInterval(session.watchdogTimer);
    if (session.metadataTimer) clearInterval(session.metadataTimer);
    session.watchdogTimer = undefined;
    session.metadataTimer = undefined;
    const handle = session.icy;
    session.icy = undefined;
    if (!handle) return;
    try {
      handle.res.unpipe();
      handle.audioStream.destroy();
      handle.res.destroy();
      handle.req.destroy();
    } catch (error) {
      logger.warn("stream.close_failed", { ...sessionContext(session), error: errorMessage(error) });
    }
  }

  private async stopSession(session: GuildSession, reason: string): Promise<void> {
    if (session.stopPromise) return session.stopPromise;
    const task = this.performStopSession(session, reason);
    session.stopPromise = task;
    try {
      await task;
    } finally {
      if (session.stopPromise === task) session.stopPromise = undefined;
    }
  }

  private async performStopSession(session: GuildSession, reason: string): Promise<void> {
    session.stopping = true;
    session.status = "stopping";
    this.cancelIdleTimer(session);
    this.closeStream(session);
    if (session.nowPlayingUpdateTimer) clearTimeout(session.nowPlayingUpdateTimer);
    logger.info("session.stopping", { ...sessionContext(session), reason });
    try {
      session.player.stop(true);
    } catch {
      // Already stopped.
    }
    try {
      if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        session.connection.destroy();
      }
    } catch {
      // Already destroyed.
    }
    await this.updatePersistentAsStopped(session, reason);
    session.status = "stopped";
    if (this.sessions.get(session.guildId) === session) this.sessions.delete(session.guildId);
    this.syncPresence();
    logger.info("session.stopped", { ...sessionContext(session), reason });
  }

  private async sendText(session: GuildSession, content: string): Promise<void> {
    const channel = await this.getSendableChannel(session.textChannelId);
    if (!channel) return;
    await channel.send({ content, allowedMentions: { parse: [] } }).catch((error: unknown) => {
      logger.warn("text.send_failed", { ...sessionContext(session), error: errorMessage(error) });
    });
  }

  private async getSendableChannel(channelId: string): Promise<SendableChannel | null> {
    const channel =
      this.client.channels.cache.get(channelId) ??
      (await this.client.channels.fetch(channelId).catch(() => null));
    if (!channel || !("send" in channel) || typeof channel.send !== "function") return null;
    return channel as unknown as SendableChannel;
  }

  private schedulePersistentNowPlayingUpdate(session: GuildSession): void {
    if (!session.nowPlayingMessage || session.stopping || session.nowPlayingUpdateTimer) return;
    session.nowPlayingUpdateTimer = setTimeout(() => {
      session.nowPlayingUpdateTimer = undefined;
      void this.publishPersistentNowPlaying(session, false);
    }, 1_000);
  }

  private async publishPersistentNowPlaying(session: GuildSession, create: boolean): Promise<void> {
    const metadataUpdatedAt = session.metadataUpdatedAt;
    const revision = ++session.nowPlayingRevision;
    const payload = await this.buildNowPlayingPayload(session);
    // Descargar la portada puede tardar: si mientras tanto empezo otra
    // actualizacion, esta ya esta obsoleta y no debe pisar a la nueva.
    if (revision !== session.nowPlayingRevision || session.stopping) return;
    if (session.nowPlayingMessage) {
      await session.nowPlayingMessage
        .edit({ ...payload, attachments: [] })
        .catch((error: unknown) => {
          logger.warn("now_playing.edit_failed", { ...sessionContext(session), error: errorMessage(error) });
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
    if (
      session.nowPlayingMessage &&
      session.metadataUpdatedAt !== metadataUpdatedAt
    ) {
      this.schedulePersistentNowPlayingUpdate(session);
    }
  }

  private async buildNowPlayingPayload(session: GuildSession): Promise<EmbedPayload> {
    const title = session.currentTitle;
    const [listeners, artwork] = await Promise.all([
      this.humanListenerCount(session),
      this.resolveArtwork(session, session.currentArtworkUrl, true),
    ]);
    const embed = new EmbedBuilder()
      .setColor(session.status === "playing" ? 0x2ecc71 : 0xf39c12)
      .setTitle(session.stationName)
      .setDescription(
        title
          ? `Sonando ahora\n▶️ **${title}**`
          : "_Esperando información de la canción..._",
      )
      .addFields(
        {
          name: "Estado",
          value: session.status === "playing" ? "Activo" : this.statusLabel(session.status),
          inline: true,
        },
        { name: "Canal", value: `<#${session.voiceChannelId}>`, inline: true },
        { name: "Oyentes", value: String(listeners), inline: true },
      )
      .setFooter({
        text: session.metadataSource
          ? `Actualizado desde ${session.metadataSource.toUpperCase()}`
          : "Esperando metadata",
      })
      .setTimestamp();
    return { embeds: [embed], files: this.attachArtwork(embed, artwork) };
  }

  private async updatePersistentAsStopped(session: GuildSession, reason: string): Promise<void> {
    if (!session.nowPlayingMessage) return;
    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle(session.stationName)
      .setDescription(session.currentTitle ? `Ultima cancion: **${session.currentTitle}**` : "Radio detenida")
      .addFields({ name: "Estado", value: "Desconectada", inline: true })
      .setFooter({ text: `Motivo: ${this.stopReasonLabel(reason)}` })
      .setTimestamp();
    // Sin descarga: no retrasamos la desconexion esperando a la red.
    const artwork = await this.resolveArtwork(session, session.currentArtworkUrl, false);
    const files = this.attachArtwork(embed, artwork);
    await session.nowPlayingMessage.edit({ embeds: [embed], files, attachments: [] }).catch(() => null);
  }

  // La portada se sube como adjunto en vez de enlazar la URL: asi Discord no
  // depende de su proxy de imagenes externas, que a veces falla al descargarla
  // y deja el embed sin portada.
  private async resolveArtwork(
    session: GuildSession,
    url: string | null,
    allowDownload: boolean,
  ): Promise<Artwork | null> {
    if (url && session.artwork?.url === url) return session.artwork;
    if (url && allowDownload) {
      for (let attempt = 1; attempt <= ARTWORK_DOWNLOAD_ATTEMPTS; attempt += 1) {
        try {
          const artwork = await downloadArtwork(url);
          if (session.currentArtworkUrl === url) session.artwork = artwork;
          return artwork;
        } catch (error) {
          logger.warn("artwork.download_failed", {
            ...sessionContext(session),
            url,
            attempt,
            error: errorMessage(error),
          });
        }
      }
    }
    return this.fallbackArtwork();
  }

  private fallbackArtwork(): Promise<Artwork | null> {
    this.fallbackArtworkPromise ??= readFile(FALLBACK_ARTWORK_PATH)
      .then((data): Artwork => ({ url: null, data, fileName: "cover.png" }))
      .catch((error: unknown) => {
        logger.warn("artwork.fallback_unavailable", {
          path: FALLBACK_ARTWORK_PATH,
          error: errorMessage(error),
        });
        return null;
      });
    return this.fallbackArtworkPromise;
  }

  private attachArtwork(embed: EmbedBuilder, artwork: Artwork | null): AttachmentBuilder[] {
    if (!artwork) return [];
    embed.setThumbnail(`attachment://${artwork.fileName}`);
    return [new AttachmentBuilder(artwork.data, { name: artwork.fileName })];
  }

  private openIcyStream(url: string, redirectDepth = 0): Promise<IcyHandle> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;
      let settled = false;
      const request = lib.get(
        parsedUrl,
        {
          headers: {
            "User-Agent": "monkey-bot/0.2",
            "Icy-MetaData": "1",
            Accept: "audio/*,*/*;q=0.8",
          },
        },
        (response) => {
          clearTimeout(openTimeout);
          const status = response.statusCode ?? 0;
          const location = headerValue(response.headers.location);
          if ([301, 302, 303, 307, 308].includes(status) && location) {
            response.resume();
            response.destroy();
            if (redirectDepth >= MAX_REDIRECTS) {
              settled = true;
              reject(new Error("Demasiadas redirecciones en el stream"));
              return;
            }
            let nextUrl: string;
            try {
              nextUrl = new URL(location, parsedUrl).toString();
            } catch {
              settled = true;
              reject(new Error("El stream respondio con una redireccion invalida"));
              return;
            }
            settled = true;
            this.openIcyStream(nextUrl, redirectDepth + 1).then(resolve, reject);
            return;
          }
          if (status < 200 || status >= 300) {
            response.resume();
            response.destroy();
            settled = true;
            reject(new Error(`El stream respondio HTTP ${status}`));
            return;
          }

          const metaint = Number.parseInt(headerValue(response.headers["icy-metaint"]) ?? "", 10);
          if (Number.isFinite(metaint) && metaint > 0) {
            const demuxer = new IcyDemuxer(metaint);
            response.on("error", (error) => demuxer.destroy(error));
            response.pipe(demuxer);
            settled = true;
            resolve({ req: request, res: response, audioStream: demuxer, demuxer });
          } else {
            settled = true;
            resolve({ req: request, res: response, audioStream: response, demuxer: null });
          }
        },
      );
      const openTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        request.destroy();
        reject(new Error("Timeout abriendo el stream"));
      }, STREAM_OPEN_TIMEOUT_MS);
      request.on("error", (error) => {
        clearTimeout(openTimeout);
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  private statusLabel(status: SessionStatus): string {
    return {
      connecting: "Conectando",
      playing: "Reproduciendo",
      reconnecting: "Reconectando",
      stopping: "Desconectando",
      stopped: "Desconectada",
    }[status];
  }

  private stopReasonLabel(reason: string): string {
    return {
      command: "comando /stop",
      manual_disconnect: "desconexión manual desde Discord",
      idle_timeout: "canal sin oyentes",
      retries_exhausted: "fallos de conexión",
      shutdown: "apagado del bot",
      replaced: "sesión trasladada",
      connection_destroyed: "conexión cerrada",
    }[reason] ?? reason;
  }

  private connectionIsDestroyed(connection: VoiceConnection): boolean {
    return connection.state.status === VoiceConnectionStatus.Destroyed;
  }

  private formatDuration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return `${hours}h ${minutes}m ${remainder}s`;
  }
}
