// Ciclo de vida de las sesiones de voz, una por servidor: conexion al canal,
// reconexion con backoff, desconexion por inactividad, salida manual del bot
// y cierre ordenado. El audio llega del reproductor compartido de Broadcast.
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Client, VoiceState } from "discord.js";
import { randomUUID } from "node:crypto";
import { errorMessage } from "../errors";
import { logger } from "../logger";
import { MAX_START_ATTEMPTS, retryDelayMs, sleep } from "./backoff";
import type { Broadcast } from "./Broadcast";
import type { NowPlayingMessages } from "./NowPlayingMessages";
import { sessionContext, type GuildSession } from "./session";

const CONNECTION_READY_TIMEOUT_MS = 20_000;

export class VoiceSessions {
  private readonly sessions = new Map<string, GuildSession>();
  // Reintentos de voz acumulados (metrica).
  private retriesTotal = 0;

  constructor(
    private readonly client: Client,
    private readonly config: { idleDisconnectMinutes: number },
    private readonly broadcast: Broadcast,
    private readonly messages: NowPlayingMessages,
    // Se llama al terminar de cerrar una sesion (actualiza la presencia).
    private readonly onSessionClosed: () => void,
  ) {}

  public get size(): number {
    return this.sessions.size;
  }

  public get totalRetries(): number {
    return this.retriesTotal;
  }

  public get(guildId: string): GuildSession | undefined {
    return this.sessions.get(guildId);
  }

  public values(): IterableIterator<GuildSession> {
    return this.sessions.values();
  }

  public create(params: {
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

  public async start(session: GuildSession): Promise<void> {
    // La voz y el stream arrancan en paralelo; si el stream ya esta sonando
    // para otro servidor, solo hace falta conectar la voz.
    await Promise.all([this.ensureVoice(session, "initial_start", true), this.broadcast.ensure()]);
    if (session.stopping || this.sessions.get(session.guildId) !== session) {
      throw new Error("La sesion ya no esta activa");
    }
    logger.info("session.playing", sessionContext(session));
  }

  public async stop(session: GuildSession, reason: string): Promise<void> {
    if (session.stopPromise) return session.stopPromise;
    const task = this.performStop(session, reason);
    session.stopPromise = task;
    try {
      await task;
    } finally {
      if (session.stopPromise === task) session.stopPromise = undefined;
    }
  }

  public requestIdleRefresh(session: GuildSession): void {
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

  public async listenerCount(session: GuildSession): Promise<number> {
    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) return 0;
    const channel =
      guild.channels.cache.get(session.voiceChannelId) ??
      (await guild.channels.fetch(session.voiceChannelId).catch(() => null));
    if (!channel?.isVoiceBased()) return 0;
    return channel.members.filter((member) => !member.user.bot).size;
  }

  public handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
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
      void this.stop(session, "manual_disconnect");
      return;
    }
    if (
      oldState.channelId === session.voiceChannelId ||
      newState.channelId === session.voiceChannelId
    ) {
      this.requestIdleRefresh(session);
    }
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
        void this.stop(session, "connection_destroyed");
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        queueMicrotask(() => {
          if (session.stopping || this.sessions.get(session.guildId) !== session) return;
          const guild = this.client.guilds.cache.get(session.guildId);
          const botId = this.client.user?.id;
          const botChannelId = botId ? guild?.voiceStates.cache.get(botId)?.channelId : undefined;
          if (session.status === "playing" && botChannelId !== session.voiceChannelId) {
            void this.stop(session, "manual_disconnect");
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
        this.retriesTotal += 1;
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
    await this.stop(session, "retries_exhausted");
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

  private async refreshIdleState(session: GuildSession): Promise<void> {
    const listeners = await this.listenerCount(session);
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
    const listeners = await this.listenerCount(session);
    if (listeners > 0) {
      this.cancelIdleTimer(session);
      return;
    }
    await this.messages.sendText(session, "No hay usuarios escuchando. Hasta pronto.");
    await this.stop(session, "idle_timeout");
  }

  private async performStop(session: GuildSession, reason: string): Promise<void> {
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
    this.onSessionClosed();
    logger.info("session.stopped", { ...sessionContext(session), reason });
  }

  private connectionIsDestroyed(connection: VoiceConnection): boolean {
    return connection.state.status === VoiceConnectionStatus.Destroyed;
  }
}
