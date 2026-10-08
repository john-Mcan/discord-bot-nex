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
  type PlayerSubscription,
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
const METADATA_MIN_DELAY_MS = 1_000;
const METADATA_END_GRACE_MS = 1_500;
const METADATA_OVERDUE_RETRY_MS = 2_000;
const METADATA_MAX_OVERDUE_MS = 20_000;
const BROADCAST_LINGER_MS = 15_000;

type SessionStatus =
  | "connecting"
  | "playing"
  | "reconnecting"
  | "stopping"
  | "stopped";

type BroadcastStatus = "idle" | "connecting" | "playing" | "reconnecting";

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

// Una sesion por servidor: solo su conexion de voz y su mensaje. El stream,
// el reproductor y la metadata son compartidos por todas las sesiones.
type GuildSession = {
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
    "now_playing.song.cover_url",
    "song.art",
    "song.cover_url",
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
    headers: { Accept: "image/*", "User-Agent": "discord-bot-nex/0.2" },
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

// Programa la siguiente consulta para justo despues del cambio de cancion,
// usando la hora del servidor de metadata para no depender del reloj local.
// Soporta el snapshot NEX (ends_at_ms/server_now_ms) y AzuraCast (remaining).
export function nextMetadataPollDelay(payload: unknown, fallbackMs: number): number {
  let remainingMs: number | null = null;
  const endsAt = readPath(payload, "now_playing.ends_at_ms");
  const serverNow = readPath(payload, "server_now_ms");
  if (typeof endsAt === "number" && typeof serverNow === "number") {
    remainingMs = endsAt - serverNow;
  } else {
    const remaining = readPath(payload, "now_playing.remaining");
    if (typeof remaining === "number" && remaining > 0) remainingMs = remaining * 1000;
  }
  if (remainingMs === null || !Number.isFinite(remainingMs)) return fallbackMs;
  if (remainingMs <= 0) {
    // La cancion ya termino pero la fuente aun no publica la siguiente.
    return -remainingMs < METADATA_MAX_OVERDUE_MS ? METADATA_OVERDUE_RETRY_MS : fallbackMs;
  }
  return Math.max(METADATA_MIN_DELAY_MS, Math.min(fallbackMs, remainingMs + METADATA_END_GRACE_MS));
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

function retryDelayMs(attempt: number): number {
  const delayMs = Math.min(30_000, 1_500 * 2 ** Math.min(attempt - 1, 4));
  return delayMs + Math.floor(Math.random() * 750);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

  // Transmision compartida: un solo stream HTTP y un solo reproductor (y por
  // tanto un solo FFmpeg) alimentan las conexiones de voz de todos los servidores.
  private player?: AudioPlayer;
  private broadcastStatus: BroadcastStatus = "idle";
  private broadcastEpoch = 0;
  private broadcastStartPromise?: Promise<void>;
  private broadcastLingerTimer?: NodeJS.Timeout;
  private broadcastRetries = 0;
  private lastStreamError: string | null = null;
  private icy?: IcyHandle;
  private streamGeneration = 0;
  private watchdogTimer?: NodeJS.Timeout;
  private lastAudioAt: number | null = null;
  private stationName: string;

  // Metadata compartida: una sola consulta y una sola descarga de portada
  // por cancion, sin importar cuantos servidores esten escuchando.
  private currentTitle: string | null = null;
  private currentArtworkUrl: string | null = null;
  private metadataSource: MetadataSource = null;
  private metadataUpdatedAt = 0;
  private metadataTimer?: NodeJS.Timeout;
  private metadataPolling = false;
  private artwork?: Artwork;
  private artworkDownload?: { url: string; promise: Promise<Artwork | null> };

  constructor(
    private readonly client: Client,
    private readonly config: RadioManagerConfig,
  ) {
    this.metadataUrl = config.metadataUrl ?? inferAzuraCastMetadataUrl(config.streamUrl);
    this.stationName = config.stationName ?? "Radio";
  }

  public recordCommand(command: string): void {
    this.commandCounts.set(command, (this.commandCounts.get(command) ?? 0) + 1);
  }

  public getMetrics(): RadioMetrics {
    const statuses = [...this.sessions.values()].map((session) => this.effectiveStatus(session));
    return {
      sessions: statuses.length,
      playingSessions: statuses.filter((status) => status === "playing").length,
      reconnectingSessions: statuses.filter((status) => status === "reconnecting").length,
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
        const status = this.effectiveStatus(existing);
        await interaction.editReply(
          status === "playing"
            ? `Ya estoy reproduciendo en **${voiceChannel.name}**.`
            : `La sesion de **${voiceChannel.name}** esta ${this.statusLabel(status).toLowerCase()}.`,
        );
        await this.publishPersistentNowPlaying(existing, true);
        this.requestIdleRefresh(existing);
        return;
      }

      const listenerCount = await this.humanListenerCount(existing);
      const canMove = member.permissions.has(PermissionFlagsBits.MoveMembers);
      if (listenerCount > 0 && !canMove) {
        await interaction.editReply(
          `Ya estoy reproduciendo en <#${existing.voiceChannelId}>. ` +
            "Necesitas **Mover miembros** para trasladarme mientras haya oyentes.",
        );
        return;
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
      await this.startSession(session);
      if (this.sessions.get(guild.id) !== session || session.status !== "playing") {
        throw new Error("La sesion termino antes de iniciar la reproduccion");
      }
      await interaction.editReply(`Reproduciendo **${this.stationName}** en **${voiceChannel.name}**.`);
      await this.publishPersistentNowPlaying(session, true);
      this.requestIdleRefresh(session);
    } catch (error) {
      logger.error("play.failed", { ...sessionContext(session), error: errorMessage(error) });
      await interaction.editReply(`No pude iniciar la radio: ${errorMessage(error)}`).catch(() => null);
      if (this.sessions.get(guild.id) === session) await this.stopSession(session, "start_failed");
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
    const status = this.effectiveStatus(session);
    const lastError = session.lastError ?? this.lastStreamError;
    const embed = new EmbedBuilder()
      .setColor(status === "playing" ? 0x2ecc71 : 0xf39c12)
      .setTitle(`Estado — ${this.stationName}`)
      .addFields(
        { name: "Estado", value: this.statusLabel(status), inline: true },
        { name: "Canal", value: `<#${session.voiceChannelId}>`, inline: true },
        { name: "Oyentes", value: String(listeners), inline: true },
        { name: "Uptime", value: this.formatDuration(uptimeMs), inline: true },
        { name: "Ping voz", value: `WS ${ping.ws ?? "—"} ms / UDP ${ping.udp ?? "—"} ms`, inline: true },
        { name: "Reintentos", value: `Voz ${session.totalRetries} / Stream ${this.broadcastRetries}`, inline: true },
        { name: "Metadata", value: this.metadataSource?.toUpperCase() ?? "No disponible", inline: true },
        { name: "Ultimo audio", value: this.lastAudioAt ? `<t:${Math.floor(this.lastAudioAt / 1000)}:R>` : "—", inline: true },
      )
      .setTimestamp();
    if (lastError) embed.addFields({ name: "Ultimo error", value: lastError.slice(0, 1024) });
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
    this.stopBroadcast();
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

    const session: GuildSession = {
      id: randomUUID(),
      guildId: params.guildId,
      voiceChannelId: params.voiceChannelId,
      textChannelId: params.textChannelId,
      createdAt: Date.now(),
      status: "connecting",
      connection,
      subscription: connection.subscribe(this.ensurePlayer()),
      idleGeneration: 0,
      idleRefreshRequested: false,
      totalRetries: 0,
      lastError: null,
      nowPlayingRevision: 0,
      stopping: false,
    };
    this.sessions.set(params.guildId, session);
    this.attachConnectionEvents(session);
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
          this.requestVoiceRecovery(session, "La conexion de voz se desconecto");
        });
      }
    });
    session.connection.on("error", (error) => {
      logger.error("voice.error", { ...sessionContext(session), error: error.message });
    });
  }

  private ensurePlayer(): AudioPlayer {
    if (this.player) return this.player;
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.on("error", (error) => {
      this.requestStreamRecovery(`Error del reproductor: ${error.message}`);
    });
    player.on("stateChange", (oldState, newState) => {
      logger.info("player.state_changed", {
        previousState: oldState.status,
        nextState: newState.status,
      });
      if (
        this.broadcastStatus !== "idle" &&
        oldState.status !== AudioPlayerStatus.Idle &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        this.requestStreamRecovery("El stream termino o dejo de entregar audio");
      }
    });
    this.player = player;
    return player;
  }

  private async startSession(session: GuildSession): Promise<void> {
    // La voz y el stream arrancan en paralelo; si el stream ya esta sonando
    // para otro servidor, solo hace falta conectar la voz.
    await Promise.all([
      this.ensureVoice(session, "initial_start", true),
      this.ensureBroadcast(),
    ]);
    if (session.stopping || this.sessions.get(session.guildId) !== session) {
      throw new Error("La sesion ya no esta activa");
    }
    logger.info("session.playing", sessionContext(session));
  }

  private requestVoiceRecovery(session: GuildSession, reason: string): void {
    if (session.stopping || this.sessions.get(session.guildId) !== session) return;
    if (session.voiceRecoveryPromise) return;
    session.lastError = reason;
    logger.warn("voice.failure", { ...sessionContext(session), reason });
    void this.ensureVoice(session, reason, false).catch((error) => {
      logger.error("voice.recovery_failed", {
        ...sessionContext(session),
        error: errorMessage(error),
      });
    });
  }

  private async ensureVoice(
    session: GuildSession,
    reason: string,
    initial: boolean,
  ): Promise<void> {
    if (session.voiceRecoveryPromise) return session.voiceRecoveryPromise;
    const recovery = this.recoverVoice(session, reason, initial);
    session.voiceRecoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (session.voiceRecoveryPromise === recovery) session.voiceRecoveryPromise = undefined;
    }
  }

  private async recoverVoice(session: GuildSession, reason: string, initial: boolean): Promise<void> {
    let lastError = reason;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      if (session.stopping || this.sessions.get(session.guildId) !== session) {
        throw new Error("La sesion ya no esta activa");
      }
      if (attempt > 1 || !initial) {
        session.status = "reconnecting";
        session.totalRetries += 1;
        this.totalRetries += 1;
        await this.sendText(
          session,
          `La radio perdio la conexion. Reintentando (${attempt}/${MAX_START_ATTEMPTS})...`,
        );
        await sleep(retryDelayMs(attempt));
      } else {
        session.status = "connecting";
      }

      try {
        await this.ensureConnectionReady(session);
        session.status = "playing";
        session.lastError = null;
        logger.info("voice.ready", { ...sessionContext(session), attempt });
        if (!initial) this.schedulePersistentNowPlayingUpdate(session);
        return;
      } catch (error) {
        lastError = errorMessage(error);
        session.lastError = lastError;
        logger.warn("voice.start_attempt_failed", {
          ...sessionContext(session),
          attempt,
          error: lastError,
        });
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

  private ensureBroadcast(): Promise<void> {
    this.cancelBroadcastLinger();
    if (this.broadcastStatus === "playing") return Promise.resolve();
    return this.broadcastStartPromise ?? this.runBroadcast("initial_start", true);
  }

  private requestStreamRecovery(reason: string): void {
    if (this.broadcastStatus === "idle" || this.broadcastStartPromise) return;
    this.streamFailures += 1;
    this.lastStreamError = reason;
    logger.warn("stream.failure", { reason, sessions: this.sessions.size });
    if (this.sessions.size === 0) {
      this.stopBroadcast();
      return;
    }
    void this.runBroadcast(reason, false).catch((error) => {
      logger.error("stream.recovery_failed", { error: errorMessage(error) });
    });
  }

  private async runBroadcast(reason: string, initial: boolean): Promise<void> {
    const task = this.recoverBroadcast(reason, initial);
    this.broadcastStartPromise = task;
    try {
      await task;
    } finally {
      if (this.broadcastStartPromise === task) {
        this.broadcastStartPromise = undefined;
        if (
          this.broadcastStatus === "playing" &&
          this.player?.state.status === AudioPlayerStatus.Idle
        ) {
          this.requestStreamRecovery("El stream termino inmediatamente despues de iniciar");
        }
      }
    }
  }

  private async recoverBroadcast(reason: string, initial: boolean): Promise<void> {
    // Si la transmision se detiene (y quiza vuelve a arrancar) mientras este
    // intento espera, la epoca cambia y este intento abandona sin tocar nada.
    const epoch = this.broadcastEpoch;
    const stillCurrent = () => epoch === this.broadcastEpoch;
    this.startMetadataPolling();
    let lastError = reason;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      if (attempt > 1 || !initial) {
        this.broadcastStatus = "reconnecting";
        this.broadcastRetries += 1;
        this.totalRetries += 1;
        await this.broadcastText(
          `La radio perdio la conexion. Reintentando (${attempt}/${MAX_START_ATTEMPTS})...`,
        );
        await sleep(retryDelayMs(attempt));
      } else {
        this.broadcastStatus = "connecting";
      }
      if (!stillCurrent()) throw new Error("La radio se detuvo");

      try {
        await this.startStream();
        if (!stillCurrent()) throw new Error("La radio se detuvo");
        this.broadcastStatus = "playing";
        this.lastStreamError = null;
        logger.info("stream.playing", { attempt, sessions: this.sessions.size });
        for (const session of this.sessions.values()) this.schedulePersistentNowPlayingUpdate(session);
        return;
      } catch (error) {
        if (!stillCurrent()) throw new Error("La radio se detuvo");
        lastError = errorMessage(error);
        this.lastStreamError = lastError;
        logger.warn("stream.start_attempt_failed", { attempt, error: lastError });
        this.closeStream();
      }
    }

    await this.broadcastText("No pude mantener la radio activa y me desconectare.");
    await Promise.all(
      [...this.sessions.values()].map((session) => this.stopSession(session, "retries_exhausted")),
    );
    if (stillCurrent()) this.stopBroadcast();
    throw new Error(lastError);
  }

  private async startStream(): Promise<void> {
    this.closeStream();
    const generation = ++this.streamGeneration;
    const handle = await this.openIcyStream(this.config.streamUrl);
    if (generation !== this.streamGeneration) {
      handle.req.destroy();
      handle.res.destroy();
      handle.audioStream.destroy();
      throw new Error("El inicio del stream fue reemplazado");
    }
    this.icy = handle;
    this.lastAudioAt = Date.now();
    this.stationName =
      this.config.stationName ??
      headerValue(handle.res.headers["icy-name"]) ??
      "Radio";

    if (handle.demuxer) {
      handle.demuxer.on("metadata", (metadata: Buffer) => {
        if (generation !== this.streamGeneration) return;
        try {
          const title = parseIcyMetadata(metadata);
          if (title) this.handleMetadata(title, "icy");
        } catch (error) {
          logger.warn("metadata.icy_parse_failed", { error: errorMessage(error) });
        }
      });
    }

    const passThrough = new PassThrough({ highWaterMark: AUDIO_HIGH_WATER_MARK });
    passThrough.on("data", () => {
      if (generation === this.streamGeneration) this.lastAudioAt = Date.now();
    });
    const fail = (error: Error) => {
      if (generation !== this.streamGeneration) return;
      passThrough.destroy(error);
      this.requestStreamRecovery(`Fallo del stream HTTP: ${error.message}`);
    };
    handle.audioStream.on("error", fail);
    handle.res.on("aborted", () => fail(new Error("Respuesta HTTP abortada")));
    handle.audioStream.pipe(passThrough);

    this.watchdogTimer = setInterval(() => {
      if (
        generation === this.streamGeneration &&
        this.lastAudioAt &&
        Date.now() - this.lastAudioAt > STREAM_STALL_TIMEOUT_MS
      ) {
        fail(new Error("El stream no entrego audio durante 45 segundos"));
      }
    }, STREAM_WATCHDOG_INTERVAL_MS);

    const player = this.ensurePlayer();
    player.play(createAudioResource(passThrough, { inputType: StreamType.Arbitrary }));
    await entersState(player, AudioPlayerStatus.Playing, PLAYER_START_TIMEOUT_MS);
  }

  private closeStream(): void {
    this.streamGeneration += 1;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    const handle = this.icy;
    this.icy = undefined;
    if (!handle) return;
    try {
      handle.res.unpipe();
      handle.audioStream.destroy();
      handle.res.destroy();
      handle.req.destroy();
    } catch (error) {
      logger.warn("stream.close_failed", { error: errorMessage(error) });
    }
  }

  private scheduleBroadcastShutdown(): void {
    // Margen antes de cortar el stream: un /play poco despues (o un traslado
    // de canal) reutiliza la transmision en vez de reabrirla.
    if (this.sessions.size > 0 || this.broadcastLingerTimer) return;
    this.broadcastLingerTimer = setTimeout(() => {
      this.broadcastLingerTimer = undefined;
      if (this.sessions.size === 0) this.stopBroadcast();
    }, BROADCAST_LINGER_MS);
  }

  private cancelBroadcastLinger(): void {
    if (this.broadcastLingerTimer) clearTimeout(this.broadcastLingerTimer);
    this.broadcastLingerTimer = undefined;
  }

  private stopBroadcast(): void {
    this.cancelBroadcastLinger();
    if (this.broadcastStatus === "idle" && !this.broadcastStartPromise && !this.metadataPolling) return;
    this.broadcastEpoch += 1;
    this.broadcastStatus = "idle";
    this.broadcastStartPromise = undefined;
    this.broadcastRetries = 0;
    this.lastStreamError = null;
    this.closeStream();
    this.stopMetadataPolling();
    try {
      this.player?.stop(true);
    } catch {
      // Already stopped.
    }
    this.lastAudioAt = null;
    this.currentTitle = null;
    this.currentArtworkUrl = null;
    this.metadataSource = null;
    this.metadataUpdatedAt = 0;
    this.artwork = undefined;
    this.artworkDownload = undefined;
    logger.info("broadcast.stopped");
  }

  private startMetadataPolling(): void {
    if (!this.metadataUrl || this.metadataPolling) return;
    this.metadataPolling = true;
    const epoch = this.broadcastEpoch;
    const poll = async () => {
      this.metadataTimer = undefined;
      if (epoch !== this.broadcastEpoch || !this.metadataUrl) return;
      let delayMs = this.config.metadataPollSeconds * 1000;
      try {
        const response = await fetch(this.metadataUrl, {
          headers: { Accept: "application/json", "User-Agent": "discord-bot-nex/0.2" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        if (body.length > 1_000_000) throw new Error("La respuesta de metadata supera 1 MB");
        const payload: unknown = JSON.parse(body);
        if (epoch !== this.broadcastEpoch) return;
        const title = extractMetadataTitle(
          payload,
          this.config.metadataTitlePath,
          this.config.metadataArtistPath,
        );
        const artworkUrl = extractMetadataArtwork(payload, this.config.metadataArtworkPath);
        if (title) this.handleMetadata(title, "json", artworkUrl);
        delayMs = nextMetadataPollDelay(payload, delayMs);
      } catch (error) {
        logger.warn("metadata.poll_failed", { error: errorMessage(error) });
      }
      if (epoch !== this.broadcastEpoch) return;
      this.metadataTimer = setTimeout(() => void poll(), delayMs);
    };
    void poll();
  }

  private stopMetadataPolling(): void {
    if (this.metadataTimer) clearTimeout(this.metadataTimer);
    this.metadataTimer = undefined;
    this.metadataPolling = false;
  }

  private handleMetadata(
    rawTitle: string,
    source: Exclude<MetadataSource, null>,
    artworkUrl?: string | null,
  ): void {
    const title = rawTitle.replace(/\0/g, "").trim().slice(0, 300);
    if (!title) return;
    if (
      source === "icy" &&
      this.metadataSource === "json" &&
      Date.now() - this.metadataUpdatedAt < this.config.metadataPollSeconds * 2_000
    ) return;
    const titleChanged = title !== this.currentTitle;
    const artworkChanged = artworkUrl !== undefined && artworkUrl !== this.currentArtworkUrl;
    if (!titleChanged && !artworkChanged && source === this.metadataSource) {
      if (source === "json") this.metadataUpdatedAt = Date.now();
      return;
    }
    this.currentTitle = title;
    if (artworkUrl !== undefined) this.currentArtworkUrl = artworkUrl;
    this.metadataSource = source;
    this.metadataUpdatedAt = Date.now();
    this.metadataUpdates += 1;
    logger.info("metadata.updated", {
      source,
      title,
      hasArtwork: Boolean(this.currentArtworkUrl),
      sessions: this.sessions.size,
    });
    if (this.sessions.size > 0) this.schedulePresence(title);
    for (const session of this.sessions.values()) this.schedulePersistentNowPlayingUpdate(session);
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
    const active = [...this.sessions.values()].some((session) => !session.stopping);
    if (active && this.currentTitle) {
      this.schedulePresence(this.currentTitle);
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
    if (session.nowPlayingUpdateTimer) clearTimeout(session.nowPlayingUpdateTimer);
    logger.info("session.stopping", { ...sessionContext(session), reason });
    try {
      session.subscription?.unsubscribe();
    } catch {
      // Already unsubscribed.
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
    this.scheduleBroadcastShutdown();
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

  private async broadcastText(content: string): Promise<void> {
    const sessions = [...this.sessions.values()].filter((session) => !session.stopping);
    await Promise.all(sessions.map((session) => this.sendText(session, content)));
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
    const metadataUpdatedAt = this.metadataUpdatedAt;
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
      this.metadataUpdatedAt !== metadataUpdatedAt
    ) {
      this.schedulePersistentNowPlayingUpdate(session);
    }
  }

  private async buildNowPlayingPayload(session: GuildSession): Promise<EmbedPayload> {
    const title = this.currentTitle;
    const [listeners, artwork] = await Promise.all([
      this.humanListenerCount(session),
      this.resolveArtwork(this.currentArtworkUrl, true),
    ]);
    const status = this.effectiveStatus(session);
    const embed = new EmbedBuilder()
      .setColor(status === "playing" ? 0x2ecc71 : 0xf39c12)
      .setTitle(this.stationName)
      .setDescription(
        title
          ? `Sonando ahora\n▶️ **${title}**`
          : "_Esperando información de la canción..._",
      )
      .addFields(
        {
          name: "Estado",
          value: status === "playing" ? "Activo" : this.statusLabel(status),
          inline: true,
        },
        { name: "Canal", value: `<#${session.voiceChannelId}>`, inline: true },
        { name: "Oyentes", value: String(listeners), inline: true },
      )
      .setFooter({
        text: this.metadataSource
          ? `Actualizado desde ${this.metadataSource.toUpperCase()}`
          : "Esperando metadata",
      })
      .setTimestamp();
    return { embeds: [embed], files: this.attachArtwork(embed, artwork) };
  }

  private async updatePersistentAsStopped(session: GuildSession, reason: string): Promise<void> {
    if (!session.nowPlayingMessage) return;
    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle(this.stationName)
      .setDescription(this.currentTitle ? `Ultima cancion: **${this.currentTitle}**` : "Radio detenida")
      .addFields({ name: "Estado", value: "Desconectada", inline: true })
      .setFooter({ text: `Motivo: ${this.stopReasonLabel(reason)}` })
      .setTimestamp();
    // Sin descarga: no retrasamos la desconexion esperando a la red.
    const artwork = await this.resolveArtwork(this.currentArtworkUrl, false);
    const files = this.attachArtwork(embed, artwork);
    await session.nowPlayingMessage.edit({ embeds: [embed], files, attachments: [] }).catch(() => null);
  }

  // La portada se sube como adjunto en vez de enlazar la URL: asi Discord no
  // depende de su proxy de imagenes externas, que a veces falla al descargarla
  // y deja el embed sin portada.
  private async resolveArtwork(url: string | null, allowDownload: boolean): Promise<Artwork | null> {
    if (url && this.artwork?.url === url) return this.artwork;
    if (url && allowDownload) {
      // Todas las sesiones que publican a la vez comparten la misma descarga.
      let download = this.artworkDownload;
      if (!download || download.url !== url) {
        const promise = this.downloadArtworkWithRetry(url);
        const current = { url, promise };
        download = current;
        this.artworkDownload = current;
        void promise.then(() => {
          if (this.artworkDownload === current) this.artworkDownload = undefined;
        });
      }
      const artwork = await download.promise;
      if (artwork) return artwork;
    }
    return this.fallbackArtwork();
  }

  private async downloadArtworkWithRetry(url: string): Promise<Artwork | null> {
    for (let attempt = 1; attempt <= ARTWORK_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        const artwork = await downloadArtwork(url);
        if (this.currentArtworkUrl === url) this.artwork = artwork;
        return artwork;
      } catch (error) {
        logger.warn("artwork.download_failed", { url, attempt, error: errorMessage(error) });
      }
    }
    return null;
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

  private effectiveStatus(session: GuildSession): SessionStatus {
    if (session.status !== "playing") return session.status;
    if (this.broadcastStatus === "playing") return "playing";
    return this.broadcastStatus === "reconnecting" ? "reconnecting" : "connecting";
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
            "User-Agent": "discord-bot-nex/0.2",
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
      start_failed: "no se pudo iniciar",
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
