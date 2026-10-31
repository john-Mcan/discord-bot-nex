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
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
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
import { PassThrough } from "node:stream";
import { errorMessage } from "../errors";
import { logger } from "../logger";
import { CoverCache, loadStationLogo, type Artwork } from "./artwork";
import { MAX_START_ATTEMPTS, retryDelayMs, sleep } from "./backoff";
import {
  AUDIO_HIGH_WATER_MARK,
  headerValue,
  openIcyStream,
  parseIcyMetadata,
  type IcyHandle,
} from "./icy";
import {
  EMPTY_EXTRAS,
  extractMetadataArtwork,
  extractMetadataExtras,
  extractMetadataSong,
  inferAzuraCastMetadataUrl,
  nextMetadataPollDelay,
  songLabel,
  splitIcyTitle,
  type MetadataExtras,
  type SongInfo,
} from "./metadata";
import {
  buildNowPlayingPayload,
  buildStatusEmbed,
  buildStoppedPayload,
  statusLabel,
  type EmbedPayload,
  type Station,
} from "./nowPlayingView";
import { sessionContext, type GuildSession, type SessionStatus } from "./session";

const PLAYER_START_TIMEOUT_MS = 20_000;
const CONNECTION_READY_TIMEOUT_MS = 20_000;
const STREAM_STALL_TIMEOUT_MS = 45_000;
const STREAM_WATCHDOG_INTERVAL_MS = 15_000;
const PRESENCE_UPDATE_INTERVAL_MS = 10_000;
const BROADCAST_LINGER_MS = 15_000;
const NOW_PLAYING_DEBOUNCE_MS = 300;

type BroadcastStatus = "idle" | "connecting" | "playing" | "reconnecting";

type MetadataSource = "icy" | "json" | null;

type SendableChannel = {
  send: (options: {
    content?: string;
    embeds?: EmbedBuilder[];
    files?: AttachmentBuilder[];
    components?: ActionRowBuilder<ButtonBuilder>[];
    allowedMentions?: { parse: never[] };
  }) => Promise<Message>;
};

export type RadioManagerConfig = {
  streamUrl: string;
  stationName: string | null;
  websiteUrl: string | null;
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
  private stationLogoPromise?: Promise<Artwork | null>;
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
  private currentSong: SongInfo | null = null;
  private currentExtras: MetadataExtras = EMPTY_EXTRAS;
  private currentArtworkUrl: string | null = null;
  private metadataSource: MetadataSource = null;
  private metadataUpdatedAt = 0;
  private metadataTimer?: NodeJS.Timeout;
  private metadataPolling = false;
  private readonly covers = new CoverCache((url) => url === this.currentArtworkUrl);

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
            : `La sesion de **${voiceChannel.name}** esta ${statusLabel(status).toLowerCase()}.`,
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
      await interaction.editReply(
        `Reproduciendo **${this.stationName}** en **${voiceChannel.name}**.`,
      );
      await this.publishPersistentNowPlaying(session, true);
      this.requestIdleRefresh(session);
    } catch (error) {
      logger.error("play.failed", { ...sessionContext(session), error: errorMessage(error) });
      await interaction
        .editReply(`No pude iniciar la radio: ${errorMessage(error)}`)
        .catch(() => null);
      if (this.sessions.get(guild.id) === session) await this.stopSession(session, "start_failed");
    }
  }

  public async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "Este comando solo funciona en un servidor.",
        ephemeral: true,
      });
      return;
    }
    const session = this.sessions.get(guild.id);
    if (!session || session.stopping) {
      await interaction.reply({
        content: "No hay una radio activa en este servidor.",
        ephemeral: true,
      });
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
      await interaction.reply({
        content: "No hay una radio activa en este servidor.",
        ephemeral: true,
      });
      return;
    }
    if (!(await this.defer(interaction))) return;
    await interaction.editReply(await this.buildNowPlayingPayload(session));
  }

  public async status(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = interaction.guildId ? this.sessions.get(interaction.guildId) : undefined;
    if (!session || session.stopping) {
      await interaction.reply({
        content: "No hay una radio activa en este servidor.",
        ephemeral: true,
      });
      return;
    }
    const listeners = await this.humanListenerCount(session);
    const embed = buildStatusEmbed({
      stationName: this.stationName,
      status: this.effectiveStatus(session),
      voiceChannelId: session.voiceChannelId,
      listeners,
      uptimeMs: Date.now() - session.createdAt,
      ping: session.connection.ping,
      voiceRetries: session.totalRetries,
      streamRetries: this.broadcastRetries,
      metadataSource: this.metadataSource,
      lastAudioAt: this.lastAudioAt,
      lastError: session.lastError ?? this.lastStreamError,
    });
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
    await Promise.all(
      [...this.sessions.values()].map((session) => this.stopSession(session, "shutdown")),
    );
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

  private async resolveMember(
    interaction: ChatInputCommandInteraction,
  ): Promise<GuildMember | null> {
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
    await Promise.all([this.ensureVoice(session, "initial_start", true), this.ensureBroadcast()]);
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

  private async recoverVoice(
    session: GuildSession,
    reason: string,
    initial: boolean,
  ): Promise<void> {
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
      if (session.connection.state.status === VoiceConnectionStatus.Disconnected || attempt > 1) {
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
        for (const session of this.sessions.values())
          this.schedulePersistentNowPlayingUpdate(session);
        return;
      } catch (error) {
        if (!stillCurrent()) throw new Error("La radio se detuvo", { cause: error });
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
    const handle = await openIcyStream(this.config.streamUrl);
    if (generation !== this.streamGeneration) {
      handle.req.destroy();
      handle.res.destroy();
      handle.audioStream.destroy();
      throw new Error("El inicio del stream fue reemplazado");
    }
    this.icy = handle;
    this.lastAudioAt = Date.now();
    this.stationName =
      this.config.stationName ?? headerValue(handle.res.headers["icy-name"]) ?? "Radio";

    if (handle.demuxer) {
      handle.demuxer.on("metadata", (metadata: Buffer) => {
        if (generation !== this.streamGeneration) return;
        try {
          const title = parseIcyMetadata(metadata);
          if (title)
            this.handleMetadata({ source: "icy", label: title, song: splitIcyTitle(title) });
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
    if (this.broadcastStatus === "idle" && !this.broadcastStartPromise && !this.metadataPolling)
      return;
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
    this.currentSong = null;
    this.currentExtras = EMPTY_EXTRAS;
    this.currentArtworkUrl = null;
    this.metadataSource = null;
    this.metadataUpdatedAt = 0;
    this.covers.clear();
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
        const song = extractMetadataSong(
          payload,
          this.config.metadataTitlePath,
          this.config.metadataArtistPath,
        );
        if (song) {
          this.handleMetadata({
            source: "json",
            label: songLabel(song),
            song,
            artworkUrl: extractMetadataArtwork(payload, this.config.metadataArtworkPath),
            extras: extractMetadataExtras(payload),
          });
        }
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

  private handleMetadata(update: {
    source: Exclude<MetadataSource, null>;
    label: string;
    song: SongInfo;
    artworkUrl?: string | null;
    extras?: MetadataExtras;
  }): void {
    const { source, artworkUrl } = update;
    const title = update.label.replace(/\0/g, "").trim().slice(0, 300);
    if (!title) return;
    if (
      source === "icy" &&
      this.metadataSource === "json" &&
      Date.now() - this.metadataUpdatedAt < this.config.metadataPollSeconds * 2_000
    )
      return;
    const titleChanged = title !== this.currentTitle;
    const artworkChanged = artworkUrl !== undefined && artworkUrl !== this.currentArtworkUrl;
    // ICY no trae tiempos ni votacion: si cambia la cancion por ICY, los datos
    // del snapshot anterior ya no aplican.
    const extras = update.extras ?? (titleChanged ? EMPTY_EXTRAS : this.currentExtras);
    const extrasChanged =
      extras.endsAt !== this.currentExtras.endsAt ||
      extras.voted !== this.currentExtras.voted ||
      extras.votingOpen !== this.currentExtras.votingOpen;
    if (!titleChanged && !artworkChanged && !extrasChanged && source === this.metadataSource) {
      if (source === "json") this.metadataUpdatedAt = Date.now();
      return;
    }
    this.currentTitle = title;
    this.currentSong = update.song;
    this.currentExtras = extras;
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
    if (this.sessions.size > 0) {
      this.schedulePresence(title);
      // La portada empieza a bajar ya, en paralelo con la espera de la edicion.
      if (artworkChanged) void this.covers.resolve(this.currentArtworkUrl, true);
    }
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
    return channel;
  }

  private schedulePersistentNowPlayingUpdate(session: GuildSession): void {
    if (!session.nowPlayingMessage || session.stopping || session.nowPlayingUpdateTimer) return;
    session.nowPlayingUpdateTimer = setTimeout(() => {
      session.nowPlayingUpdateTimer = undefined;
      void this.publishPersistentNowPlaying(session, false);
    }, NOW_PLAYING_DEBOUNCE_MS);
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
    if (session.nowPlayingMessage && this.metadataUpdatedAt !== metadataUpdatedAt) {
      this.schedulePersistentNowPlayingUpdate(session);
    }
  }

  private async buildNowPlayingPayload(session: GuildSession): Promise<EmbedPayload> {
    const song = this.currentSong;
    const extras = this.currentExtras;
    const [listeners, cover, logo] = await Promise.all([
      this.humanListenerCount(session),
      this.covers.resolve(this.currentArtworkUrl, true),
      this.stationLogo(),
    ]);
    return buildNowPlayingPayload({
      station: this.station(),
      status: this.effectiveStatus(session),
      song,
      extras,
      listeners,
      voiceChannelId: session.voiceChannelId,
      cover,
      logo,
    });
  }

  private async updatePersistentAsStopped(session: GuildSession, reason: string): Promise<void> {
    if (!session.nowPlayingMessage) return;
    // Sin descarga: no retrasamos la desconexion esperando a la red.
    const [cover, logo] = await Promise.all([
      this.covers.resolve(this.currentArtworkUrl, false),
      this.stationLogo(),
    ]);
    const payload = buildStoppedPayload(this.station(), reason, this.currentSong, cover, logo);
    await session.nowPlayingMessage.edit({ ...payload, attachments: [] }).catch(() => null);
  }

  private station(): Station {
    return { name: this.stationName, websiteUrl: this.config.websiteUrl };
  }

  private stationLogo(): Promise<Artwork | null> {
    this.stationLogoPromise ??= loadStationLogo();
    return this.stationLogoPromise;
  }

  private effectiveStatus(session: GuildSession): SessionStatus {
    if (session.status !== "playing") return session.status;
    if (this.broadcastStatus === "playing") return "playing";
    return this.broadcastStatus === "reconnecting" ? "reconnecting" : "connecting";
  }

  private connectionIsDestroyed(connection: VoiceConnection): boolean {
    return connection.state.status === VoiceConnectionStatus.Destroyed;
  }
}
