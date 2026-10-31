import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  MetadataTracker,
  type MetadataChange,
  type MetadataTrackerOptions,
} from "../src/radio/MetadataTracker";

function tracker(options: Partial<MetadataTrackerOptions> = {}) {
  const changes: MetadataChange[] = [];
  const metadata = new MetadataTracker({
    url: null,
    titlePath: null,
    artistPath: null,
    artworkPath: null,
    pollSeconds: 15,
    onChange: (change) => changes.push(change),
    ...options,
  });
  return { metadata, changes };
}

async function jsonServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const requestTimes: number[] = [];
  const server = createServer((req, res) => {
    requestTimes.push(Date.now());
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/snapshot`;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { url, requestTimes, close };
}

function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) resolve();
      else if (Date.now() - startedAt > timeoutMs) reject(new Error("Tiempo de espera agotado"));
      else setTimeout(check, 10);
    };
    check();
  });
}

test("ICY actualiza la cancion y separa artista y titulo", () => {
  const { metadata, changes } = tracker();
  metadata.handleIcyTitle("Guns N' Roses - Patience");
  assert.equal(metadata.title, "Guns N' Roses - Patience");
  assert.deepEqual(metadata.song, { title: "Patience", artist: "Guns N' Roses" });
  assert.equal(metadata.source, "icy");
  assert.equal(metadata.updates, 1);
  assert.deepEqual(changes, [
    { source: "icy", title: "Guns N' Roses - Patience", artworkChanged: false },
  ]);
  // El mismo titulo no vuelve a notificar.
  metadata.handleIcyTitle("Guns N' Roses - Patience");
  assert.equal(changes.length, 1);
  // Un titulo vacio se ignora.
  metadata.handleIcyTitle(" \0 ");
  assert.equal(metadata.title, "Guns N' Roses - Patience");
});

test("el titulo se limpia de nulos y espacios y se corta en 300 caracteres", () => {
  const { metadata } = tracker();
  metadata.update({ source: "json", label: "  Tema\0  ", song: { title: "Tema", artist: null } });
  assert.equal(metadata.title, "Tema");
  metadata.update({ source: "json", label: "x".repeat(400), song: { title: "x", artist: null } });
  assert.equal(metadata.title?.length, 300);
});

test("el JSON reciente tiene prioridad sobre ICY", () => {
  const { metadata, changes } = tracker({ pollSeconds: 15 });
  metadata.update({
    source: "json",
    label: "Artista — Tema",
    song: { title: "Tema", artist: "Artista" },
    artworkUrl: "https://img.example/a.jpg",
    extras: { endsAt: 1_000, voted: true, votingOpen: false },
  });
  metadata.handleIcyTitle("Otro - Distinto");
  assert.equal(metadata.title, "Artista — Tema");
  assert.equal(metadata.source, "json");
  assert.deepEqual(changes, [{ source: "json", title: "Artista — Tema", artworkChanged: true }]);
});

test("un snapshot igual no notifica pero renueva la vigencia del JSON", () => {
  const { metadata, changes } = tracker();
  const update = {
    source: "json" as const,
    label: "A — B",
    song: { title: "B", artist: "A" },
    artworkUrl: null,
    extras: { endsAt: 5_000, voted: false, votingOpen: false },
  };
  metadata.update(update);
  const firstUpdatedAt = metadata.updatedAt;
  const startedAt = Date.now();
  while (Date.now() === startedAt) {
    // Espera al siguiente milisegundo.
  }
  metadata.update(update);
  assert.equal(changes.length, 1);
  assert.ok(metadata.updatedAt > firstUpdatedAt);
  // Si cambian los extras (por ejemplo, se abre la votacion) si notifica.
  metadata.update({ ...update, extras: { ...update.extras, votingOpen: true } });
  assert.equal(changes.length, 2);
  assert.equal(changes[1]?.artworkChanged, false);
});

test("si ICY cambia la cancion, los extras del snapshot anterior se descartan", () => {
  const { metadata } = tracker({ pollSeconds: 5 });
  metadata.update({
    source: "json",
    label: "A - B",
    song: { title: "B", artist: "A" },
    extras: { endsAt: 9_000, voted: true, votingOpen: true },
  });
  // Pasado el doble del intervalo, el JSON ya no es reciente y ICY se acepta.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    // El mismo titulo por ICY conserva los extras...
    metadata.handleIcyTitle("A - B");
    assert.equal(metadata.source, "icy");
    assert.equal(metadata.extras.endsAt, 9_000);
    // ...pero una cancion nueva los limpia.
    metadata.handleIcyTitle("C - D");
  } finally {
    Date.now = realNow;
  }
  assert.equal(metadata.title, "C - D");
  assert.deepEqual(metadata.extras, { endsAt: null, voted: false, votingOpen: false });
});

test("stop olvida la cancion pero conserva el total de actualizaciones", () => {
  const { metadata } = tracker();
  metadata.handleIcyTitle("A - B");
  metadata.stop();
  assert.equal(metadata.title, null);
  assert.equal(metadata.song, null);
  assert.equal(metadata.source, null);
  assert.equal(metadata.updatedAt, 0);
  assert.equal(metadata.updates, 1);
  assert.equal(metadata.polling, false);
});

test("consulta el JSON al iniciar y de nuevo al terminar la cancion (fin + 1,3 s)", async () => {
  let serverNowMs = 1_790_000_000_000;
  const { url, requestTimes, close } = await jsonServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        server_now_ms: serverNowMs,
        phase: "VOTING",
        now_playing: {
          // Faltan 200 ms para que termine: la siguiente consulta va a fin + 1,3 s.
          ends_at_ms: serverNowMs + 200,
          song: { title: "Tema", artist: "Artista", cover_url: "https://img.example/c.jpg" },
        },
      }),
    );
    serverNowMs += 1_500;
  });
  const { metadata, changes } = tracker({ url });
  try {
    metadata.start();
    assert.equal(metadata.polling, true);
    await waitFor(() => requestTimes.length >= 2);
    const gap = (requestTimes[1] ?? 0) - (requestTimes[0] ?? 0);
    assert.ok(gap >= 1_400 && gap < 3_000, `segunda consulta a los ${gap} ms`);
    assert.deepEqual(metadata.song, { title: "Tema", artist: "Artista" });
    assert.equal(metadata.artworkUrl, "https://img.example/c.jpg");
    assert.equal(metadata.extras.votingOpen, true);
    assert.equal(metadata.source, "json");
    assert.ok(changes.length >= 1);
  } finally {
    metadata.stop();
    await close();
  }
});

test("una respuesta que llega despues de stop se descarta", async () => {
  const { url, requestTimes, close } = await jsonServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ title: "Tarde" }));
    }, 100);
  });
  const { metadata, changes } = tracker({ url });
  try {
    metadata.start();
    await waitFor(() => requestTimes.length === 1);
    metadata.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(metadata.title, null);
    assert.deepEqual(changes, []);
    assert.equal(requestTimes.length, 1);
  } finally {
    await close();
  }
});

test("sin URL de metadata no consulta", () => {
  const { metadata } = tracker({ url: null });
  metadata.start();
  assert.equal(metadata.polling, false);
});
