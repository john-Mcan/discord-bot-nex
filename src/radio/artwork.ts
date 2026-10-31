// Imagenes del mensaje "sonando ahora": portada de la cancion (descargada una
// vez y compartida por todos los servidores) y logo de la radio como respaldo.
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "../errors";
import { logger } from "../logger";

const ARTWORK_DOWNLOAD_TIMEOUT_MS = 8_000;
const ARTWORK_DOWNLOAD_ATTEMPTS = 2;
const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;
// Logo de la radio: icono de la cabecera del mensaje y portada de respaldo.
export const STATION_LOGO_PATH = path.resolve(__dirname, "../../img/icon-512.png");
const STATION_LOGO_FILE = "logo.png";
const ARTWORK_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type Artwork = {
  url: string | null;
  data: Buffer;
  fileName: string;
};

export async function downloadArtwork(
  url: string,
  timeoutMs = ARTWORK_DOWNLOAD_TIMEOUT_MS,
): Promise<Artwork> {
  const response = await fetch(url, {
    headers: { Accept: "image/*", "User-Agent": "discord-bot-nex/0.2" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = ARTWORK_EXTENSIONS[contentType];
  if (!extension)
    throw new Error(`Tipo de contenido no soportado: ${contentType || "desconocido"}`);
  if (Number(response.headers.get("content-length")) > MAX_ARTWORK_BYTES) {
    throw new Error("La portada supera el tamano maximo");
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length === 0) throw new Error("La portada esta vacia");
  if (data.length > MAX_ARTWORK_BYTES) throw new Error("La portada supera el tamano maximo");
  return { url, data, fileName: `cover.${extension}` };
}

// Portada de la cancion actual. Todas las sesiones comparten una descarga por
// cancion; isCurrent evita guardar la portada de una cancion que ya cambio.
export class CoverCache {
  private cover?: Artwork;
  private download?: { url: string; promise: Promise<Artwork | null> };

  constructor(private readonly isCurrent: (url: string) => boolean) {}

  public async resolve(url: string | null, allowDownload: boolean): Promise<Artwork | null> {
    if (!url) return null;
    if (this.cover?.url === url) return this.cover;
    if (!allowDownload) return null;
    // Todas las sesiones que publican a la vez comparten la misma descarga.
    let download = this.download;
    if (!download || download.url !== url) {
      const promise = this.downloadWithRetry(url);
      const current = { url, promise };
      download = current;
      this.download = current;
      void promise.then(() => {
        if (this.download === current) this.download = undefined;
      });
    }
    return download.promise;
  }

  public clear(): void {
    this.cover = undefined;
    this.download = undefined;
  }

  private async downloadWithRetry(url: string): Promise<Artwork | null> {
    for (let attempt = 1; attempt <= ARTWORK_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        const artwork = await downloadArtwork(url);
        if (this.isCurrent(url)) this.cover = artwork;
        return artwork;
      } catch (error) {
        logger.warn("artwork.download_failed", { url, attempt, error: errorMessage(error) });
      }
    }
    return null;
  }
}

export function loadStationLogo(): Promise<Artwork | null> {
  return readFile(STATION_LOGO_PATH)
    .then((data): Artwork => ({ url: null, data, fileName: STATION_LOGO_FILE }))
    .catch((error: unknown) => {
      logger.warn("artwork.logo_unavailable", {
        path: STATION_LOGO_PATH,
        error: errorMessage(error),
      });
      return null;
    });
}
