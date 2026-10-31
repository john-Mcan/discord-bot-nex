import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import ffmpegPath from "ffmpeg-static";
import { Broadcast } from "../src/radio/Broadcast";
import { MetadataTracker } from "../src/radio/MetadataTracker";

// Prueba de integracion: stream HTTP con metadata ICY -> FFmpeg real ->
// reproductor de @discordjs/voice, sin conectarse a Discord.

const METAINT = 8_192;

function silenceMp3(seconds: number): Buffer {
  assert.ok(ffmpegPath, "ffmpeg-static no encontro un binario para esta plataforma");
  return execFileSync(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}`,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

// Intercala un bloque de metadata ICY cada METAINT bytes de audio.
function withIcyMetadata(audio: Buffer, title: string): Buffer {
  const text = Buffer.from(`StreamTitle='${title}';`, "utf8");
  const block = Buffer.alloc(Math.ceil(text.length / 16) * 16);
  text.copy(block);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < audio.length; offset += METAINT) {
    parts.push(audio.subarray(offset, offset + METAINT));
    if (offset === 0) parts.push(Buffer.from([block.length / 16]), block);
    else parts.push(Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) resolve();
      else if (Date.now() - startedAt > timeoutMs) reject(new Error(`No se cumplio: ${label}`));
      else setTimeout(check, 25);
    };
    check();
  });
}

test("transmite el stream con FFmpeg, lee ICY y se reconecta si se corta", async () => {
  const body = withIcyMetadata(silenceMp3(30), "Artista - Tema");
  const responses: ServerResponse[] = [];
  const server = createServer((_req, res) => {
    responses.push(res);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "icy-metaint": String(METAINT),
      "icy-name": "NEX Prueba",
    });
    // No se cierra la respuesta: como una radio en vivo, el stream sigue abierto.
    // La primera rafaga es menor que METAINT para que el titulo llegue despues.
    res.write(body.subarray(0, 4_096));
    setTimeout(() => {
      if (!res.destroyed) res.write(body.subarray(4_096));
    }, 200);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const streamUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/live`;

  const notices: string[] = [];
  let playingEvents = 0;
  let exhausted = false;
  const metadata = new MetadataTracker({
    url: null,
    titlePath: null,
    artistPath: null,
    artworkPath: null,
    pollSeconds: 15,
    onChange: () => undefined,
  });
  const broadcast = new Broadcast({ streamUrl, stationName: null }, metadata, {
    sessionCount: () => 1,
    notify: (content) => {
      notices.push(content);
      return Promise.resolve();
    },
    onPlaying: () => {
      playingEvents += 1;
    },
    onRetriesExhausted: () => {
      exhausted = true;
      return Promise.resolve();
    },
  });

  try {
    await broadcast.ensure();
    assert.equal(broadcast.status, "playing");
    assert.equal(broadcast.stationName, "NEX Prueba");
    assert.equal(playingEvents, 1);
    assert.ok(broadcast.lastAudioAt);
    await waitFor(() => metadata.title === "Artista - Tema", 5_000, "titulo ICY");
    assert.deepEqual(metadata.song, { title: "Tema", artist: "Artista" });
    // Pedir la transmision de nuevo no abre otra conexion.
    await broadcast.ensure();
    assert.equal(responses.length, 1);

    // Se corta la conexion con la radio: reintenta con backoff y vuelve a sonar.
    responses[0]?.socket?.destroy();
    await waitFor(() => broadcast.status === "reconnecting", 5_000, "reconectando");
    assert.deepEqual(notices, ["La radio perdio la conexion. Reintentando (1/5)..."]);
    await waitFor(() => broadcast.status === "playing", 15_000, "vuelve a sonar");
    assert.equal(responses.length, 2);
    assert.equal(playingEvents, 2);
    assert.equal(broadcast.failures, 1);
    assert.equal(broadcast.retries, 1);
    assert.equal(broadcast.totalRetries, 1);
    assert.equal(broadcast.lastError, null);
    assert.equal(exhausted, false);
  } finally {
    broadcast.stop();
    for (const res of responses) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(broadcast.status, "idle");
  assert.equal(broadcast.retries, 0);
  assert.equal(broadcast.lastAudioAt, null);
  assert.equal(metadata.title, null);
});
