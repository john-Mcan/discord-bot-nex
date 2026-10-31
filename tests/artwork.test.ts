import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { downloadArtwork } from "../src/radio/RadioManager";

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
