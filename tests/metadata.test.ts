import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMetadataArtwork,
  extractMetadataExtras,
  extractMetadataSong,
  extractMetadataTitle,
  inferAzuraCastMetadataUrl,
  nextMetadataPollDelay,
  readPath,
  splitIcyTitle,
} from "../src/radio/RadioManager";

// Respuesta real (recortada) de https://api.nex-radio.com/api/radio/snapshot.
const nexSnapshot = {
  station_id: "main",
  phase: "VOTING",
  server_now_ms: 1_790_000_000_000,
  now_playing: {
    song: {
      title: "BbY WOW",
      artist: "KAROL G, Judeline",
      cover_url: "https://media.example/covers/abc-123",
    },
    ends_at_ms: 1_790_000_042_000,
    is_voted: false,
    play_source: "voted",
  },
};

// Respuesta (recortada) de /api/nowplaying/<estacion> de AzuraCast.
const azuraCastNowPlaying = {
  station: { shortcode: "nex" },
  now_playing: {
    played_at: 1_790_000_000,
    duration: 180,
    elapsed: 170,
    remaining: 10,
    song: {
      text: "Guns N' Roses - Patience",
      artist: "Guns N' Roses",
      title: "Patience",
      art: "https://radio.example/api/station/nex/art/abc.jpg",
    },
  },
};

test("readPath recorre rutas por puntos y devuelve undefined si se corta", () => {
  const payload = { a: { b: { c: "valor" } }, list: [{ title: "primero" }], empty: null };
  assert.equal(readPath(payload, "a.b.c"), "valor");
  assert.deepEqual(readPath(payload, "a.b"), { c: "valor" });
  assert.equal(readPath(payload, "list.0.title"), "primero");
  assert.equal(readPath(payload, "a.x.c"), undefined);
  assert.equal(readPath(payload, "a.b.c.d"), undefined);
  assert.equal(readPath(payload, "empty.title"), undefined);
  assert.equal(readPath("texto", "length"), undefined);
  assert.equal(readPath(null, "a"), undefined);
});

test("extractMetadataTitle soporta payload AzuraCast y paths configurables", () => {
  const azura = {
    now_playing: { song: { artist: "Artist", title: "Track" } },
  };
  assert.equal(extractMetadataTitle(azura, null, null), "Artist — Track");

  const custom = { radio: { current: { performer: "Band", name: "Live" } } };
  assert.equal(
    extractMetadataTitle(custom, "radio.current.name", "radio.current.performer"),
    "Band — Live",
  );
  assert.equal(readPath(custom, "radio.current.name"), "Live");
});

test("extractMetadataTitle no duplica el artista si ya viene incluido", () => {
  const payload = { title: "Artist - Track", artist: "Artist" };
  assert.equal(extractMetadataTitle(payload, null, null), "Artist - Track");
  // La comparacion ignora mayusculas.
  assert.deepEqual(extractMetadataSong({ title: "ARTIST - Track", artist: "artist" }, null, null), {
    title: "ARTIST - Track",
    artist: null,
  });
});

test("extrae cancion, portada y extras del snapshot del backend NEX", () => {
  assert.deepEqual(extractMetadataSong(nexSnapshot, null, null), {
    title: "BbY WOW",
    artist: "KAROL G, Judeline",
  });
  assert.equal(extractMetadataTitle(nexSnapshot, null, null), "KAROL G, Judeline — BbY WOW");
  assert.equal(extractMetadataArtwork(nexSnapshot, null), "https://media.example/covers/abc-123");
  assert.deepEqual(extractMetadataExtras(nexSnapshot), {
    endsAt: 1_790_000_042_000,
    voted: true,
    votingOpen: true,
  });
});

test("extrae cancion, portada y fin de cancion de AzuraCast", () => {
  assert.deepEqual(extractMetadataSong(azuraCastNowPlaying, null, null), {
    title: "Patience",
    artist: "Guns N' Roses",
  });
  assert.equal(
    extractMetadataArtwork(azuraCastNowPlaying, null),
    "https://radio.example/api/station/nex/art/abc.jpg",
  );
  assert.deepEqual(extractMetadataExtras(azuraCastNowPlaying), {
    endsAt: 1_790_000_180_000,
    voted: false,
    votingOpen: false,
  });
});

test("autodetecta formatos comunes en orden de prioridad", () => {
  assert.deepEqual(extractMetadataSong({ song: { title: "A", artist: "B" } }, null, null), {
    title: "A",
    artist: "B",
  });
  assert.deepEqual(extractMetadataSong({ current: { title: "A", artist: "B" } }, null, null), {
    title: "A",
    artist: "B",
  });
  assert.deepEqual(extractMetadataSong({ data: { title: "A", artist: "B" } }, null, null), {
    title: "A",
    artist: "B",
  });
  // AzuraCast sin titulo separado: usa el texto completo.
  assert.deepEqual(
    extractMetadataSong({ now_playing: { song: { text: "B - A" } } }, null, null),
    { title: "B - A", artist: null },
  );
  assert.deepEqual(extractMetadataSong({ currentSong: "Tema" }, null, null), {
    title: "Tema",
    artist: null,
  });
  assert.deepEqual(extractMetadataSong({ StreamTitle: "Tema" }, null, null), {
    title: "Tema",
    artist: null,
  });
  // now_playing.song.title tiene prioridad sobre title en la raiz.
  assert.deepEqual(
    extractMetadataSong({ title: "Raiz", now_playing: { song: { title: "Anidado" } } }, null, null),
    { title: "Anidado", artist: null },
  );
});

test("las rutas configuradas tienen prioridad y caen a la autodeteccion", () => {
  const payload = {
    title: "Autodetectado",
    artist: "Artista auto",
    custom: { name: "Configurado", by: "Artista configurado", image: "https://img.example/c.png" },
    art: "https://img.example/auto.png",
  };
  assert.deepEqual(extractMetadataSong(payload, "custom.name", "custom.by"), {
    title: "Configurado",
    artist: "Artista configurado",
  });
  assert.equal(extractMetadataArtwork(payload, "custom.image"), "https://img.example/c.png");
  // Si la ruta configurada no existe, sigue con las rutas conocidas.
  assert.deepEqual(extractMetadataSong(payload, "no.existe", "tampoco"), {
    title: "Autodetectado",
    artist: "Artista auto",
  });
  assert.equal(extractMetadataArtwork(payload, "no.existe"), "https://img.example/auto.png");
});

test("ignora textos vacios o que no son string y recorta espacios", () => {
  assert.equal(extractMetadataSong({ title: "   " }, null, null), null);
  assert.equal(extractMetadataSong({ title: 42 }, null, null), null);
  assert.equal(extractMetadataSong({}, null, null), null);
  assert.equal(extractMetadataSong(null, null, null), null);
  assert.deepEqual(extractMetadataSong({ title: "  Tema  ", artist: "  " }, null, null), {
    title: "Tema",
    artist: null,
  });
});

test("extrae portada de AzuraCast y rechaza URLs no web", () => {
  const payload = {
    now_playing: { song: { art: "https://radio.example/art/song.jpg" } },
  };
  assert.equal(extractMetadataArtwork(payload, null), "https://radio.example/art/song.jpg");
  assert.equal(extractMetadataArtwork({ art: "javascript:alert(1)" }, null), null);
  assert.equal(extractMetadataArtwork({ art: "ftp://files.example/a.jpg" }, null), null);
  assert.equal(extractMetadataArtwork({ art: "no es una url" }, null), null);
  assert.equal(extractMetadataArtwork({ cover: "https://img.example" }, null), "https://img.example/");
  assert.equal(extractMetadataArtwork({}, null), null);
});

test("separa titulo y artista para mostrarlos por separado", () => {
  assert.deepEqual(
    extractMetadataSong(
      { now_playing: { song: { title: "BbY WOW", artist: "KAROL G, Judeline" } } },
      null,
      null,
    ),
    { title: "BbY WOW", artist: "KAROL G, Judeline" },
  );
  assert.deepEqual(splitIcyTitle("Guns N' Roses - Patience"), {
    title: "Patience",
    artist: "Guns N' Roses",
  });
  assert.deepEqual(splitIcyTitle("Jingle NEX"), { title: "Jingle NEX", artist: null });
  assert.deepEqual(splitIcyTitle("A - B - C"), { title: "B - C", artist: "A" });
  assert.deepEqual(splitIcyTitle(" - Tema"), { title: " - Tema", artist: null });
  assert.deepEqual(splitIcyTitle("Artista - "), { title: "Artista - ", artist: null });
});

test("extractMetadataExtras lee fin de cancion y votacion del snapshot NEX y AzuraCast", () => {
  assert.deepEqual(
    extractMetadataExtras({
      phase: "VOTING",
      now_playing: { ends_at_ms: 1_790_000_000_000, is_voted: false, play_source: "voted" },
    }),
    { endsAt: 1_790_000_000_000, voted: true, votingOpen: true },
  );
  assert.deepEqual(
    extractMetadataExtras({ now_playing: { played_at: 1_790_000_000, duration: 180 } }),
    { endsAt: 1_790_000_180_000, voted: false, votingOpen: false },
  );
  assert.deepEqual(extractMetadataExtras({}), { endsAt: null, voted: false, votingOpen: false });
});

test("extractMetadataExtras ignora tiempos invalidos y fases distintas de VOTING", () => {
  assert.equal(extractMetadataExtras({ now_playing: { ends_at_ms: Number.NaN } }).endsAt, null);
  assert.equal(extractMetadataExtras({ now_playing: { ends_at_ms: "1790000000000" } }).endsAt, null);
  assert.equal(
    extractMetadataExtras({ now_playing: { played_at: 1_790_000_000, duration: 0 } }).endsAt,
    null,
  );
  // ends_at_ms tiene prioridad sobre played_at + duration.
  assert.equal(
    extractMetadataExtras({
      now_playing: { ends_at_ms: 5_000, played_at: 1_790_000_000, duration: 180 },
    }).endsAt,
    5_000,
  );
  assert.equal(extractMetadataExtras({ now_playing: { is_voted: true } }).voted, true);
  assert.equal(extractMetadataExtras({ now_playing: { is_voted: "true" } }).voted, false);
  assert.equal(extractMetadataExtras({ phase: "PLAYING" }).votingOpen, false);
});

test("nextMetadataPollDelay consulta justo despues del fin de la cancion", () => {
  const snapshot = (remainingMs: number) => ({
    server_now_ms: 1_000_000,
    now_playing: { ends_at_ms: 1_000_000 + remainingMs },
  });
  // Faltan 5 s: consulta al terminar mas un margen de 1,3 s.
  assert.equal(nextMetadataPollDelay(snapshot(5_000), 15_000), 6_300);
  // Falta mucho: no espera mas que el intervalo normal.
  assert.equal(nextMetadataPollDelay(snapshot(120_000), 15_000), 15_000);
  // Ya termino pero la fuente no publica la siguiente: reintenta pronto...
  assert.equal(nextMetadataPollDelay(snapshot(-3_000), 15_000), 1_000);
  // ...salvo que lleve demasiado atrasada.
  assert.equal(nextMetadataPollDelay(snapshot(-60_000), 15_000), 15_000);
  // AzuraCast informa los segundos restantes.
  assert.equal(nextMetadataPollDelay({ now_playing: { remaining: 4 } }, 15_000), 5_300);
  // Sin datos de tiempo: intervalo normal.
  assert.equal(nextMetadataPollDelay({ title: "x" }, 15_000), 15_000);
});

test("nextMetadataPollDelay: fin + 1,3 s, limites del atraso y reloj del servidor", () => {
  const snapshot = (serverNowMs: number, remainingMs: number) => ({
    server_now_ms: serverNowMs,
    now_playing: { ends_at_ms: serverNowMs + remainingMs },
  });
  // Usa la hora del servidor, no la del equipo: da igual que este muy atrasada.
  assert.equal(nextMetadataPollDelay(snapshot(1_000, 200), 15_000), 1_500);
  assert.equal(nextMetadataPollDelay(snapshot(1_790_000_000_000, 200), 15_000), 1_500);
  // Justo en el cambio de cancion cuenta como atrasada.
  assert.equal(nextMetadataPollDelay(snapshot(1_000_000, 0), 15_000), 1_000);
  assert.equal(nextMetadataPollDelay(snapshot(1_000_000, -19_999), 15_000), 1_000);
  assert.equal(nextMetadataPollDelay(snapshot(1_000_000, -20_000), 15_000), 15_000);
  // El intervalo configurado manda cuando es menor que el tiempo restante.
  assert.equal(nextMetadataPollDelay(snapshot(1_000_000, 10_000), 5_000), 5_000);
  // El snapshot NEX tiene prioridad sobre remaining de AzuraCast.
  assert.equal(
    nextMetadataPollDelay(
      { server_now_ms: 0, now_playing: { ends_at_ms: 2_000, remaining: 100 } },
      15_000,
    ),
    3_300,
  );
  // Sin server_now_ms no se usa ends_at_ms.
  assert.equal(nextMetadataPollDelay({ now_playing: { ends_at_ms: 2_000 } }, 15_000), 15_000);
  // remaining en cero o negativo no sirve para programar.
  assert.equal(nextMetadataPollDelay({ now_playing: { remaining: 0 } }, 15_000), 15_000);
  assert.equal(
    nextMetadataPollDelay({ server_now_ms: 0, now_playing: { ends_at_ms: Infinity } }, 15_000),
    15_000,
  );
});

test("infiere el endpoint de metadata para streams AzuraCast", () => {
  assert.equal(
    inferAzuraCastMetadataUrl("https://stream.example/listen/my-radio/radio.mp3"),
    "https://stream.example/api/nowplaying/my-radio",
  );
  assert.equal(
    inferAzuraCastMetadataUrl("http://stream.example:8000/listen/nex/radio.aac?x=1"),
    "http://stream.example:8000/api/nowplaying/nex",
  );
  assert.equal(inferAzuraCastMetadataUrl("https://stream.example/live.mp3"), null);
  assert.equal(inferAzuraCastMetadataUrl("https://stream.example/listen/nex"), null);
  assert.equal(inferAzuraCastMetadataUrl("no es una url"), null);
});
