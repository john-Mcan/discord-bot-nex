// Cancion que suena ahora, compartida por todos los servidores. Llega por
// ICY (dentro del stream) o consultando un endpoint JSON, que se vuelve a
// consultar justo cuando termina cada cancion. Tambien guarda su portada.
import { errorMessage } from "../errors";
import { logger } from "../logger";
import { CoverCache, type Artwork } from "./artwork";
import {
  EMPTY_EXTRAS,
  extractMetadataArtwork,
  extractMetadataExtras,
  extractMetadataSong,
  nextMetadataPollDelay,
  songLabel,
  splitIcyTitle,
  type MetadataExtras,
  type SongInfo,
} from "./metadata";

export type MetadataSource = "icy" | "json";

export type MetadataUpdate = {
  source: MetadataSource;
  label: string;
  song: SongInfo;
  artworkUrl?: string | null;
  extras?: MetadataExtras;
};

export type MetadataChange = {
  source: MetadataSource;
  title: string;
  artworkChanged: boolean;
};

export type MetadataTrackerOptions = {
  // Endpoint JSON; null usa solo ICY.
  url: string | null;
  titlePath: string | null;
  artistPath: string | null;
  artworkPath: string | null;
  pollSeconds: number;
  onChange: (change: MetadataChange) => void;
};

export class MetadataTracker {
  // Una sola consulta y una sola descarga de portada por cancion, sin
  // importar cuantos servidores esten escuchando.
  private currentTitle: string | null = null;
  private currentSong: SongInfo | null = null;
  private currentExtras: MetadataExtras = EMPTY_EXTRAS;
  private currentArtworkUrl: string | null = null;
  private currentSource: MetadataSource | null = null;
  private lastUpdatedAt = 0;
  private updateCount = 0;
  private timer?: NodeJS.Timeout;
  private isPolling = false;
  // Cambia al detener la consulta: una respuesta que llega despues se descarta.
  private generation = 0;
  private readonly covers = new CoverCache((url) => url === this.currentArtworkUrl);

  constructor(private readonly options: MetadataTrackerOptions) {}

  public get title(): string | null {
    return this.currentTitle;
  }

  public get song(): SongInfo | null {
    return this.currentSong;
  }

  public get extras(): MetadataExtras {
    return this.currentExtras;
  }

  public get artworkUrl(): string | null {
    return this.currentArtworkUrl;
  }

  public get source(): MetadataSource | null {
    return this.currentSource;
  }

  // Momento de la ultima actualizacion; sirve para saber si cambio algo
  // mientras se publicaba un mensaje.
  public get updatedAt(): number {
    return this.lastUpdatedAt;
  }

  // Total acumulado de cambios de metadata (metrica).
  public get updates(): number {
    return this.updateCount;
  }

  public get polling(): boolean {
    return this.isPolling;
  }

  public cover(allowDownload: boolean): Promise<Artwork | null> {
    return this.covers.resolve(this.currentArtworkUrl, allowDownload);
  }

  public start(): void {
    if (!this.options.url || this.isPolling) return;
    this.isPolling = true;
    const generation = this.generation;
    const poll = async () => {
      this.timer = undefined;
      if (generation !== this.generation || !this.options.url) return;
      let delayMs = this.options.pollSeconds * 1000;
      try {
        const response = await fetch(this.options.url, {
          headers: { Accept: "application/json", "User-Agent": "discord-bot-nex/0.2" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        if (body.length > 1_000_000) throw new Error("La respuesta de metadata supera 1 MB");
        const payload: unknown = JSON.parse(body);
        if (generation !== this.generation) return;
        const song = extractMetadataSong(payload, this.options.titlePath, this.options.artistPath);
        if (song) {
          this.update({
            source: "json",
            label: songLabel(song),
            song,
            artworkUrl: extractMetadataArtwork(payload, this.options.artworkPath),
            extras: extractMetadataExtras(payload),
          });
        }
        delayMs = nextMetadataPollDelay(payload, delayMs);
      } catch (error) {
        logger.warn("metadata.poll_failed", { error: errorMessage(error) });
      }
      if (generation !== this.generation) return;
      this.timer = setTimeout(() => void poll(), delayMs);
    };
    void poll();
  }

  // Detiene la consulta y olvida la cancion actual y su portada.
  public stop(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.isPolling = false;
    this.currentTitle = null;
    this.currentSong = null;
    this.currentExtras = EMPTY_EXTRAS;
    this.currentArtworkUrl = null;
    this.currentSource = null;
    this.lastUpdatedAt = 0;
    this.covers.clear();
  }

  public handleIcyTitle(title: string): void {
    this.update({ source: "icy", label: title, song: splitIcyTitle(title) });
  }

  public update(update: MetadataUpdate): void {
    const { source, artworkUrl } = update;
    const title = update.label.replace(/\0/g, "").trim().slice(0, 300);
    if (!title) return;
    if (
      source === "icy" &&
      this.currentSource === "json" &&
      Date.now() - this.lastUpdatedAt < this.options.pollSeconds * 2_000
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
    if (!titleChanged && !artworkChanged && !extrasChanged && source === this.currentSource) {
      if (source === "json") this.lastUpdatedAt = Date.now();
      return;
    }
    this.currentTitle = title;
    this.currentSong = update.song;
    this.currentExtras = extras;
    if (artworkUrl !== undefined) this.currentArtworkUrl = artworkUrl;
    this.currentSource = source;
    this.lastUpdatedAt = Date.now();
    this.updateCount += 1;
    this.options.onChange({ source, title, artworkChanged });
  }
}
