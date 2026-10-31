// Transmision compartida: un solo stream HTTP y un solo reproductor (y por
// tanto un solo FFmpeg) alimentan las conexiones de voz de todos los
// servidores. Si el stream se corta, se reconecta con backoff; la metadata
// se consulta mientras la transmision esta activa.
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  type AudioPlayer,
} from "@discordjs/voice";
import { PassThrough } from "node:stream";
import { errorMessage } from "../errors";
import { logger } from "../logger";
import { MAX_START_ATTEMPTS, retryDelayMs, sleep } from "./backoff";
import {
  AUDIO_HIGH_WATER_MARK,
  headerValue,
  openIcyStream,
  parseIcyMetadata,
  type IcyHandle,
} from "./icy";
import type { MetadataTracker } from "./MetadataTracker";

const PLAYER_START_TIMEOUT_MS = 20_000;
const STREAM_STALL_TIMEOUT_MS = 45_000;
const STREAM_WATCHDOG_INTERVAL_MS = 15_000;
const BROADCAST_LINGER_MS = 15_000;

export type BroadcastStatus = "idle" | "connecting" | "playing" | "reconnecting";

export type BroadcastConfig = {
  streamUrl: string;
  // Nombre fijo de la radio; si es null se usa el encabezado icy-name.
  stationName: string | null;
};

// Lo que la transmision necesita de las sesiones de voz.
export type BroadcastHooks = {
  sessionCount(): number;
  // Aviso de texto a todos los servidores que escuchan.
  notify(content: string): Promise<void>;
  // El stream empezo o volvio a sonar: hay que actualizar los mensajes.
  onPlaying(): void;
  // Se agotaron los reintentos: hay que cerrar todas las sesiones.
  onRetriesExhausted(): Promise<void>;
};

export class Broadcast {
  private player?: AudioPlayer;
  private currentStatus: BroadcastStatus = "idle";
  private epoch = 0;
  private startPromise?: Promise<void>;
  private lingerTimer?: NodeJS.Timeout;
  // Reintentos de la transmision actual (se muestran en /status).
  private retryCount = 0;
  // Totales acumulados para las metricas.
  private retriesTotal = 0;
  private failureCount = 0;
  private lastErrorMessage: string | null = null;
  private icy?: IcyHandle;
  private streamGeneration = 0;
  private watchdogTimer?: NodeJS.Timeout;
  private lastAudio: number | null = null;
  private name: string;

  constructor(
    private readonly config: BroadcastConfig,
    private readonly metadata: MetadataTracker,
    private readonly hooks: BroadcastHooks,
  ) {
    this.name = config.stationName ?? "Radio";
  }

  public get status(): BroadcastStatus {
    return this.currentStatus;
  }

  public get stationName(): string {
    return this.name;
  }

  public get retries(): number {
    return this.retryCount;
  }

  public get totalRetries(): number {
    return this.retriesTotal;
  }

  public get failures(): number {
    return this.failureCount;
  }

  public get lastError(): string | null {
    return this.lastErrorMessage;
  }

  public get lastAudioAt(): number | null {
    return this.lastAudio;
  }

  public ensurePlayer(): AudioPlayer {
    if (this.player) return this.player;
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.on("error", (error) => {
      this.requestRecovery(`Error del reproductor: ${error.message}`);
    });
    player.on("stateChange", (oldState, newState) => {
      logger.info("player.state_changed", {
        previousState: oldState.status,
        nextState: newState.status,
      });
      if (
        this.currentStatus !== "idle" &&
        oldState.status !== AudioPlayerStatus.Idle &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        this.requestRecovery("El stream termino o dejo de entregar audio");
      }
    });
    this.player = player;
    return player;
  }

  public ensure(): Promise<void> {
    this.cancelLinger();
    if (this.currentStatus === "playing") return Promise.resolve();
    return this.startPromise ?? this.run("initial_start", true);
  }

  private requestRecovery(reason: string): void {
    if (this.currentStatus === "idle" || this.startPromise) return;
    this.failureCount += 1;
    this.lastErrorMessage = reason;
    logger.warn("stream.failure", { reason, sessions: this.hooks.sessionCount() });
    if (this.hooks.sessionCount() === 0) {
      this.stop();
      return;
    }
    void this.run(reason, false).catch((error) => {
      logger.error("stream.recovery_failed", { error: errorMessage(error) });
    });
  }

  private async run(reason: string, initial: boolean): Promise<void> {
    const task = this.recover(reason, initial);
    this.startPromise = task;
    try {
      await task;
    } finally {
      if (this.startPromise === task) {
        this.startPromise = undefined;
        if (
          this.currentStatus === "playing" &&
          this.player?.state.status === AudioPlayerStatus.Idle
        ) {
          this.requestRecovery("El stream termino inmediatamente despues de iniciar");
        }
      }
    }
  }

  private async recover(reason: string, initial: boolean): Promise<void> {
    // Si la transmision se detiene (y quiza vuelve a arrancar) mientras este
    // intento espera, la epoca cambia y este intento abandona sin tocar nada.
    const epoch = this.epoch;
    const stillCurrent = () => epoch === this.epoch;
    this.metadata.start();
    let lastError = reason;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      if (attempt > 1 || !initial) {
        this.currentStatus = "reconnecting";
        this.retryCount += 1;
        this.retriesTotal += 1;
        await this.hooks.notify(
          `La radio perdio la conexion. Reintentando (${attempt}/${MAX_START_ATTEMPTS})...`,
        );
        await sleep(retryDelayMs(attempt));
      } else {
        this.currentStatus = "connecting";
      }
      if (!stillCurrent()) throw new Error("La radio se detuvo");

      try {
        await this.startStream();
        if (!stillCurrent()) throw new Error("La radio se detuvo");
        this.currentStatus = "playing";
        this.lastErrorMessage = null;
        logger.info("stream.playing", { attempt, sessions: this.hooks.sessionCount() });
        this.hooks.onPlaying();
        return;
      } catch (error) {
        if (!stillCurrent()) throw new Error("La radio se detuvo", { cause: error });
        lastError = errorMessage(error);
        this.lastErrorMessage = lastError;
        logger.warn("stream.start_attempt_failed", { attempt, error: lastError });
        this.closeStream();
      }
    }

    await this.hooks.notify("No pude mantener la radio activa y me desconectare.");
    await this.hooks.onRetriesExhausted();
    if (stillCurrent()) this.stop();
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
    this.lastAudio = Date.now();
    this.name = this.config.stationName ?? headerValue(handle.res.headers["icy-name"]) ?? "Radio";

    if (handle.demuxer) {
      handle.demuxer.on("metadata", (block: Buffer) => {
        if (generation !== this.streamGeneration) return;
        try {
          const title = parseIcyMetadata(block);
          if (title) this.metadata.handleIcyTitle(title);
        } catch (error) {
          logger.warn("metadata.icy_parse_failed", { error: errorMessage(error) });
        }
      });
    }

    const passThrough = new PassThrough({ highWaterMark: AUDIO_HIGH_WATER_MARK });
    passThrough.on("data", () => {
      if (generation === this.streamGeneration) this.lastAudio = Date.now();
    });
    const fail = (error: Error) => {
      if (generation !== this.streamGeneration) return;
      passThrough.destroy(error);
      this.requestRecovery(`Fallo del stream HTTP: ${error.message}`);
    };
    handle.audioStream.on("error", fail);
    handle.res.on("aborted", () => fail(new Error("Respuesta HTTP abortada")));
    handle.audioStream.pipe(passThrough);

    this.watchdogTimer = setInterval(() => {
      if (
        generation === this.streamGeneration &&
        this.lastAudio &&
        Date.now() - this.lastAudio > STREAM_STALL_TIMEOUT_MS
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

  public scheduleShutdown(): void {
    // Margen antes de cortar el stream: un /play poco despues (o un traslado
    // de canal) reutiliza la transmision en vez de reabrirla.
    if (this.hooks.sessionCount() > 0 || this.lingerTimer) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = undefined;
      if (this.hooks.sessionCount() === 0) this.stop();
    }, BROADCAST_LINGER_MS);
  }

  private cancelLinger(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = undefined;
  }

  public stop(): void {
    this.cancelLinger();
    if (this.currentStatus === "idle" && !this.startPromise && !this.metadata.polling) return;
    this.epoch += 1;
    this.currentStatus = "idle";
    this.startPromise = undefined;
    this.retryCount = 0;
    this.lastErrorMessage = null;
    this.closeStream();
    try {
      this.player?.stop(true);
    } catch {
      // Already stopped.
    }
    this.lastAudio = null;
    this.metadata.stop();
    logger.info("broadcast.stopped");
  }
}
