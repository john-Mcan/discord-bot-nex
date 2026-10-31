// Extraccion de metadata desde respuestas JSON (snapshot del backend NEX,
// AzuraCast u otros proveedores) y calculo de la proxima consulta.
// Funciones puras: no hacen red ni dependen del reloj local.

const METADATA_MIN_DELAY_MS = 1_000;
// La siguiente cancion empieza 1 s despues del ends_at de la anterior y el
// backend la publica justo en ese instante: se consulta 0,3 s despues.
const METADATA_END_GRACE_MS = 1_300;
const METADATA_OVERDUE_RETRY_MS = 1_000;
const METADATA_MAX_OVERDUE_MS = 20_000;

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

export type SongInfo = {
  title: string;
  artist: string | null;
};

export type MetadataExtras = {
  endsAt: number | null;
  voted: boolean;
  votingOpen: boolean;
};

export const EMPTY_EXTRAS: MetadataExtras = { endsAt: null, voted: false, votingOpen: false };

export function songLabel(song: SongInfo): string {
  return song.artist ? `${song.artist} — ${song.title}` : song.title;
}

// ICY solo trae "Artista - Titulo" en un texto; se separa para mostrarlo.
export function splitIcyTitle(text: string): SongInfo {
  const separator = text.indexOf(" - ");
  if (separator <= 0) return { title: text, artist: null };
  const artist = text.slice(0, separator).trim();
  const title = text.slice(separator + 3).trim();
  return artist && title ? { title, artist } : { title: text, artist: null };
}

export function extractMetadataTitle(
  payload: unknown,
  titlePath: string | null,
  artistPath: string | null,
): string | null {
  const song = extractMetadataSong(payload, titlePath, artistPath);
  return song ? songLabel(song) : null;
}

// Datos opcionales para el mensaje: cuando termina la cancion y, en el
// snapshot NEX, si hay votacion abierta o si la cancion fue votada.
export function extractMetadataExtras(payload: unknown): MetadataExtras {
  let endsAt: number | null = null;
  const endsAtMs = readPath(payload, "now_playing.ends_at_ms");
  const playedAt = readPath(payload, "now_playing.played_at");
  const duration = readPath(payload, "now_playing.duration");
  if (typeof endsAtMs === "number" && Number.isFinite(endsAtMs)) {
    endsAt = endsAtMs;
  } else if (typeof playedAt === "number" && typeof duration === "number" && duration > 0) {
    endsAt = (playedAt + duration) * 1000;
  }
  return {
    endsAt,
    voted:
      readPath(payload, "now_playing.is_voted") === true ||
      readPath(payload, "now_playing.play_source") === "voted",
    votingOpen: readPath(payload, "phase") === "VOTING",
  };
}

export function extractMetadataSong(
  payload: unknown,
  titlePath: string | null,
  artistPath: string | null,
): SongInfo | null {
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
    return { title: title.value, artist: null };
  }
  return { title: title.value, artist: artist.value };
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
