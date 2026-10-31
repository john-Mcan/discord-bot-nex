import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { CoverCache, downloadArtwork, loadStationLogo } from "../src/radio/artwork";

test("downloadArtwork descarga la portada y rechaza respuestas que no son imagen", async () => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const server = createServer((req, res) => {
    if (req.url === "/art.jpg") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(image);
    } else if (req.url === "/art.webp") {
      res.writeHead(200, { "Content-Type": "IMAGE/WEBP; charset=binary" });
      res.end(image);
    } else if (req.url === "/empty.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end();
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
    assert.equal((await downloadArtwork(`${base}/art.webp`)).fileName, "cover.webp");
    await assert.rejects(downloadArtwork(`${base}/empty.png`), /vacia/);
    await assert.rejects(downloadArtwork(`${base}/page`), /no soportado/);
    await assert.rejects(downloadArtwork(`${base}/missing.jpg`), /HTTP 404/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function imageServer() {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url?.startsWith("/broken")) {
      res.writeHead(500);
      res.end();
      return;
    }
    // Responde con un poco de demora para que las descargas se solapen.
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from(req.url ?? ""));
    }, 20);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { base, requests, close };
}

test("CoverCache comparte una descarga por cancion y la guarda si sigue sonando", async () => {
  const { base, requests, close } = await imageServer();
  let current = `${base}/a.png`;
  const covers = new CoverCache((url) => url === current);
  try {
    assert.equal(await covers.resolve(null, true), null);
    // Sin permiso para descargar y sin cache: no hace red.
    assert.equal(await covers.resolve(current, false), null);
    assert.equal(requests.length, 0);

    const [first, second] = await Promise.all([
      covers.resolve(current, true),
      covers.resolve(current, true),
    ]);
    assert.equal(requests.length, 1);
    assert.equal(first?.data.toString(), "/a.png");
    assert.equal(second, first);
    // Queda en cache: ya no descarga y sirve aunque no se permita descargar.
    assert.equal(await covers.resolve(current, false), first);
    assert.equal(requests.length, 1);

    // Si la cancion cambia durante la descarga, la portada no queda en cache.
    const stale = `${base}/b.png`;
    assert.equal((await covers.resolve(stale, true))?.data.toString(), "/b.png");
    assert.equal(await covers.resolve(stale, false), null);

    covers.clear();
    assert.equal(await covers.resolve(current, false), null);
    current = `${base}/c.png`;
    await covers.resolve(current, true);
    assert.deepEqual(requests, ["/a.png", "/b.png", "/c.png"]);
  } finally {
    await close();
  }
});

test("CoverCache reintenta una vez y devuelve null si la portada falla", async () => {
  const { base, requests, close } = await imageServer();
  const url = `${base}/broken.png`;
  const covers = new CoverCache(() => true);
  try {
    assert.equal(await covers.resolve(url, true), null);
    assert.deepEqual(requests, ["/broken.png", "/broken.png"]);
  } finally {
    await close();
  }
});

test("loadStationLogo lee el icono de la radio", async () => {
  const logo = await loadStationLogo();
  assert.ok(logo);
  assert.equal(logo.fileName, "logo.png");
  assert.equal(logo.url, null);
  assert.deepEqual(
    logo.data.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
});
