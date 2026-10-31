import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { IcyDemuxer, headerValue, openIcyStream, parseIcyMetadata } from "../src/radio/icy";

test("IcyDemuxer separa audio y metadata aunque los chunks esten fragmentados", async () => {
  const demuxer = new IcyDemuxer(4);
  const audio: Buffer[] = [];
  const metadata: Buffer[] = [];
  demuxer.on("data", (chunk: Buffer) => audio.push(chunk));
  demuxer.on("metadata", (chunk: Buffer) => metadata.push(chunk));

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
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0]?.subarray(0, 19).toString("latin1"), "StreamTitle='Song';");
});

test("IcyDemuxer omite bloques de metadata vacios", async () => {
  const demuxer = new IcyDemuxer(2);
  const audio: Buffer[] = [];
  let metadataEvents = 0;
  demuxer.on("data", (chunk: Buffer) => audio.push(chunk));
  demuxer.on("metadata", () => {
    metadataEvents += 1;
  });
  demuxer.end(
    Buffer.concat([Buffer.from("ab"), Buffer.from([0]), Buffer.from("cd"), Buffer.from([0])]),
  );
  await once(demuxer, "end");

  assert.equal(Buffer.concat(audio).toString(), "abcd");
  assert.equal(metadataEvents, 0);
});

test("IcyDemuxer rechaza un metaint invalido", () => {
  assert.throws(() => new IcyDemuxer(0), /metaint/);
  assert.throws(() => new IcyDemuxer(1.5), /metaint/);
});

test("parseIcyMetadata conserva apostrofes y elimina padding", () => {
  const metadata = Buffer.alloc(64);
  metadata.write("StreamTitle='Guns N' Roses - Patience';StreamUrl='';", "latin1");
  assert.equal(parseIcyMetadata(metadata), "Guns N' Roses - Patience");
});

test("parseIcyMetadata acepta UTF-8 y cae a latin1", () => {
  const title = "StreamTitle='Café Tacvba - Eres';";
  assert.equal(parseIcyMetadata(Buffer.from(title, "utf8")), "Café Tacvba - Eres");
  assert.equal(parseIcyMetadata(Buffer.from(title, "latin1")), "Café Tacvba - Eres");
  assert.equal(parseIcyMetadata(Buffer.from("StreamUrl='x';")), null);
  assert.equal(parseIcyMetadata(Buffer.from("StreamTitle='';")), null);
});

test("openIcyStream sigue redirecciones, pide metadata ICY y separa el audio", async () => {
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    if (req.url === "/listen") {
      res.writeHead(302, { Location: "/stream" });
      res.end();
    } else if (req.url === "/stream") {
      const metadata = Buffer.alloc(32);
      metadata.write("StreamTitle='A - B';", "latin1");
      res.writeHead(200, { "Content-Type": "audio/mpeg", "icy-metaint": "4", "icy-name": "NEX" });
      res.write("abcd");
      // El titulo llega despues, como en un stream real.
      setTimeout(() => res.end(Buffer.concat([Buffer.from([2]), metadata, Buffer.from("ef")])), 50);
    } else if (req.url === "/plain") {
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end("audio");
    } else if (req.url === "/loop") {
      res.writeHead(301, { Location: "/loop" });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const handle = await openIcyStream(`${base}/listen`);
    assert.equal(headers[0]?.["icy-metadata"], "1");
    assert.equal(headerValue(handle.res.headers["icy-name"]), "NEX");
    assert.ok(handle.demuxer);
    const titles: string[] = [];
    handle.demuxer.on("metadata", (block: Buffer) => titles.push(parseIcyMetadata(block) ?? ""));
    const audio: Buffer[] = [];
    for await (const chunk of handle.audioStream) audio.push(chunk as Buffer);
    assert.equal(Buffer.concat(audio).toString(), "abcdef");
    assert.deepEqual(titles, ["A - B"]);

    const plain = await openIcyStream(`${base}/plain`);
    assert.equal(plain.demuxer, null);
    assert.equal(plain.audioStream, plain.res);
    plain.res.resume();

    await assert.rejects(openIcyStream(`${base}/missing`), /El stream respondio HTTP 404/);
    await assert.rejects(openIcyStream(`${base}/loop`), /Demasiadas redirecciones/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("headerValue toma el primer valor y descarta textos vacios", () => {
  assert.equal(headerValue(["  NEX ", "otro"]), "NEX");
  assert.equal(headerValue("  "), null);
  assert.equal(headerValue(undefined), null);
  assert.equal(headerValue([]), null);
});
