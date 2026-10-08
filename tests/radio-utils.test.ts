import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import test from "node:test";
import type { Client } from "discord.js";
import { HealthServer } from "../src/health";
import {
  IcyDemuxer,
  downloadArtwork,
  extractMetadataArtwork,
  extractMetadataExtras,
  extractMetadataSong,
  extractMetadataTitle,
  inferAzuraCastMetadataUrl,
  nextMetadataPollDelay,
  splitIcyTitle,
  parseIcyMetadata,
  readPath,
} from "../src/radio/RadioManager";
import type { RadioManager } from "../src/radio/RadioManager";

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("IcyDemuxer separa audio y metadata aunque los chunks esten fragmentados", async () => {
  const demuxer = new IcyDemuxer(4);
  const audio: Buffer[] = [];
  let metadata: Buffer | null = null;
  demuxer.on("data", (chunk: Buffer) => audio.push(chunk));
  demuxer.on("metadata", (chunk: Buffer) => {
    metadata = chunk;
  });

  const metadataBlock = Buffer.alloc(32);
  metadataBlock.write("StreamTitle='Song';", "latin1");
  const input = Buffer.concat([
    Buffer.from("abcd"),
    Buffer.from([2]),
    metadataBlock,
    Buffer.from("efgh"),
  ]);
  demuxer.write(input.subarray(0, 3));
  demuxer.write(input.subarray(3, 9));
  demuxer.end(input.subarray(9));
  await once(demuxer, "end");

  assert.equal(Buffer.concat(audio).toString(), "abcdefgh");
  assert.equal(metadata?.subarray(0, 19).toString("latin1"), "StreamTitle='Song';");
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
});

test("extrae portada de AzuraCast y rechaza URLs no web", () => {
  const payload = {
    now_playing: { song: { art: "https://radio.example/art/song.jpg" } },
  };
  assert.equal(
    extractMetadataArtwork(payload, null),
    "https://radio.example/art/song.jpg",
  );
  assert.equal(extractMetadataArtwork({ art: "javascript:alert(1)" }, null), null);
});

test("extrae portada y titulo del snapshot del backend NEX", () => {
  const snapshot = {
    station_id: "main",
    now_playing: {
      song: {
        title: "Track",
        artist: "Artist",
        cover_url: "https://media.example/covers/abc-123",
      },
    },
  };
  assert.equal(extractMetadataTitle(snapshot, null, null), "Artist — Track");
  assert.equal(extractMetadataArtwork(snapshot, null), "https://media.example/covers/abc-123");
});

test("downloadArtwork descarga la portada y rechaza respuestas que no son imagen", async () => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const server = createHttpServer((req, res) => {
    if (req.url === "/art.jpg") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(image);
    } else if (req.url === "/page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html></html>");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const artwork = await downloadArtwork(`${base}/art.jpg`);
    assert.equal(artwork.fileName, "cover.jpg");
    assert.equal(artwork.url, `${base}/art.jpg`);
    assert.deepEqual(artwork.data, image);
    await assert.rejects(downloadArtwork(`${base}/page`), /no soportado/);
    await assert.rejects(downloadArtwork(`${base}/missing.jpg`), /HTTP 404/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("separa titulo y artista para mostrarlos por separado", () => {
  assert.deepEqual(
    extractMetadataSong({ now_playing: { song: { title: "BbY WOW", artist: "KAROL G, Judeline" } } }, null, null),
    { title: "BbY WOW", artist: "KAROL G, Judeline" },
  );
  assert.deepEqual(splitIcyTitle("Guns N' Roses - Patience"), { title: "Patience", artist: "Guns N' Roses" });
  assert.deepEqual(splitIcyTitle("Jingle NEX"), { title: "Jingle NEX", artist: null });
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

test("nextMetadataPollDelay consulta justo despues del fin de la cancion", () => {
  const snapshot = (remainingMs: number) => ({
    server_now_ms: 1_000_000,
    now_playing: { ends_at_ms: 1_000_000 + remainingMs },
  });
  // Faltan 5 s: consulta al terminar mas un margen de 1,5 s.
  assert.equal(nextMetadataPollDelay(snapshot(5_000), 15_000), 6_500);
  // Falta mucho: no espera mas que el intervalo normal.
  assert.equal(nextMetadataPollDelay(snapshot(120_000), 15_000), 15_000);
  // Ya termino pero la fuente no publica la siguiente: reintenta pronto...
  assert.equal(nextMetadataPollDelay(snapshot(-3_000), 15_000), 2_000);
  // ...salvo que lleve demasiado atrasada.
  assert.equal(nextMetadataPollDelay(snapshot(-60_000), 15_000), 15_000);
  // AzuraCast informa los segundos restantes.
  assert.equal(nextMetadataPollDelay({ now_playing: { remaining: 4 } }, 15_000), 5_500);
  // Sin datos de tiempo: intervalo normal.
  assert.equal(nextMetadataPollDelay({ title: "x" }, 15_000), 15_000);
});

test("infiere el endpoint de metadata para streams AzuraCast", () => {
  assert.equal(
    inferAzuraCastMetadataUrl("https://stream.example/listen/my-radio/radio.mp3"),
    "https://stream.example/api/nowplaying/my-radio",
  );
  assert.equal(inferAzuraCastMetadataUrl("https://stream.example/live.mp3"), null);
});

test("parseIcyMetadata conserva apostrofes y elimina padding", () => {
  const metadata = Buffer.alloc(64);
  metadata.write("StreamTitle='Guns N' Roses - Patience';StreamUrl='';", "latin1");
  assert.equal(parseIcyMetadata(metadata), "Guns N' Roses - Patience");
});

test("HealthServer expone health JSON y metricas Prometheus", async () => {
  const client = {
    isReady: () => true,
    ws: { ping: 42 },
  } as unknown as Client;
  const radio = {
    getMetrics: () => ({
      sessions: 1,
      playingSessions: 1,
      reconnectingSessions: 0,
      streamFailures: 2,
      totalRetries: 3,
      metadataUpdates: 4,
      commands: { play: 5 },
    }),
  } as unknown as RadioManager;
  const port = await availablePort();
  const health = new HealthServer(client, radio, "127.0.0.1", port);
  await health.start();
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json() as { discordReady: boolean }).discordReady, true);

    const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metrics = await metricsResponse.text();
    assert.match(metrics, /discord_bot_nex_playing_sessions 1/);
    assert.match(metrics, /discord_bot_nex_commands_total\{command="play"\} 5/);
  } finally {
    await health.stop();
  }
});
