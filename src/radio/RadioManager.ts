import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType,
  GuildMember,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type VoiceState,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { errorMessage } from "../errors";
import { logger } from "../logger";
import { MAX_START_ATTEMPTS, retryDelayMs, sleep } from "./backoff";
import { Broadcast } from "./Broadcast";
import { inferAzuraCastMetadataUrl } from "./metadata";
import { MetadataTracker, type MetadataChange } from "./MetadataTracker";
import { NowPlayingMessages } from "./NowPlayingMessages";
import { buildStatusEmbed, statusLabel } from "./nowPlayingView";
import { Presence } from "./presence";
import { effectiveStatus, sessionContext, type GuildSession, type SessionStatus } from "./session";

const CONNECTION_READY_TIMEOUT_MS = 20_000;

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
  private voiceRetries = 0;
  private readonly metadata: MetadataTracker;
  private readonly presence: Presence;
  private readonly broadcast: Broadcast;
  private readonly messages: NowPlayingMessages;

  constructor(
    private readonly client: Client,
    private readonly config: RadioManagerConfig,
  ) {
    this.presence = new Presence(client);
    this.metadata = new MetadataTracker({
      url: config.metadataUrl ?? inferAzuraCastMetadataUrl(config.streamUrl),
      titlePath: config.metadataTitlePath,
      artistPath: config.metadataArtistPath,
      artworkPath: config.metadataArtworkPath,
      pollSeconds: config.metadataPollSeconds,
      onChange: (change) => this.onMetadataChange(change),
    });
    this.broadcast = new Broadcast(config, this.metadata, {
      sessionCount: () => this.sessions.size,
      notify: (content) => this.messages.sendToAll(this.sessions.values(), content),
      onPlaying: () => {
        for (const session of this.sessions.values()) this.messages.scheduleUpdate(session);
      },
      onRetriesExhausted: async () => {
        await Promise.all(
          [...this.sessions.values()].map((session) =>
            this.stopSession(session, "retries_exhausted"),
          ),
        );
      },
    });
    this.messages = new NowPlayingMessages(client, this.metadata, {
      station: () => ({ name: this.broadcast.stationName, websiteUrl: config.websiteUrl }),
      statusOf: (session) => this.effectiveStatus(session),
      listenerCount: (session) => this.humanListenerCount(session),
    });
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
      streamFailures: this.broadcast.failures,
      totalRetries: this.voiceRetries + this.broadcast.totalRetries,
      metadataUpdates: this.metadata.updates,
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
        await this.messages.publish(existing, true);
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
        `Reproduciendo **${this.broadcast.stationName}** en **${voiceChannel.name}**.`,
      );
      await this.messages.publish(session, true);
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
    await interaction.editReply(await this.messages.build(session));
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
      stationName: this.broadcast.stationName,
      status: this.effectiveStatus(session),
      voiceChannelId: session.voiceChannelId,
      listeners,
      uptimeMs: Date.now() - session.createdAt,
      ping: session.connection.ping,
      voiceRetries: session.totalRetries,
      streamRetries: this.broadcast.retries,
      metadataSource: this.metadata.source,
      lastAudioAt: this.broadcast.lastAudioAt,
      lastError: session.lastError ?? this.broadcast.lastError,
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
    this.presence.dispose();
    await Promise.all(
      [...this.sessions.values()].map((session) => this.stopSession(session, "shutdown")),
    );
    this.broadcast.stop();
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
      subscription: connection.subscribe(this.broadcast.ensurePlayer()),
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

  private async startSession(session: GuildSession): Promise<void> {
    // La voz y el stream arrancan en paralelo; si el stream ya esta sonando
    // para otro servidor, solo hace falta conectar la voz.
    await Promise.all([this.ensureVoice(session, "initial_start", true), this.broadcast.ensure()]);
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
        this.voiceRetries += 1;
        await this.messages.sendText(
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
        if (!initial) this.messages.scheduleUpdate(session);
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

    await this.messages.sendText(session, "No pude mantener la radio activa y me desconectare.");
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

  private onMetadataChange({ source, title, artworkChanged }: MetadataChange): void {
    logger.info("metadata.updated", {
      source,
      title,
      hasArtwork: Boolean(this.metadata.artworkUrl),
      sessions: this.sessions.size,
    });
    if (this.sessions.size > 0) {
      this.presence.schedule(title);
      // La portada empieza a bajar ya, en paralelo con la espera de la edicion.
      if (artworkChanged) void this.metadata.cover(true);
    }
    for (const session of this.sessions.values()) this.messages.scheduleUpdate(session);
  }

  private syncPresence(): void {
    const active = [...this.sessions.values()].some((session) => !session.stopping);
    this.presence.sync(active ? this.metadata.title : null);
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
    void this.messages.sendText(
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
    await this.messages.sendText(session, "No hay usuarios escuchando. Hasta pronto.");
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
    await this.messages.markStopped(session, reason);
    session.status = "stopped";
    if (this.sessions.get(session.guildId) === session) this.sessions.delete(session.guildId);
    this.broadcast.scheduleShutdown();
    this.syncPresence();
    logger.info("session.stopped", { ...sessionContext(session), reason });
  }

  private effectiveStatus(session: GuildSession): SessionStatus {
    return effectiveStatus(session, this.broadcast.status);
  }

  private connectionIsDestroyed(connection: VoiceConnection): boolean {
    return connection.state.status === VoiceConnectionStatus.Destroyed;
  }
}
