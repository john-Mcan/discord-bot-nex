import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { IcyDemuxer, parseIcyMetadata } from "../src/radio/RadioManager";

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
