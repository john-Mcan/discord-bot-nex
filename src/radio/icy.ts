// Conexion HTTP a un stream de radio con metadata ICY (Shoutcast/Icecast):
// sigue redirecciones y separa el audio de los titulos intercalados.
import type { ClientRequest, IncomingMessage } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import { Transform, type Readable, type TransformCallback } from "node:stream";

const STREAM_OPEN_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
export const AUDIO_HIGH_WATER_MARK = 128 * 1024;

export type IcyHandle = {
  req: ClientRequest;
  res: IncomingMessage;
  audioStream: Readable;
  demuxer: IcyDemuxer | null;
};

export function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

export function parseIcyMetadata(metadata: Buffer): string | null {
  let text = metadata.toString("utf8");
  if (text.includes("�")) text = metadata.toString("latin1");
  text = text.replace(/\0/g, "");
  const marker = "StreamTitle='";
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  const end = text.indexOf("';", valueStart);
  const title = text.slice(valueStart, end >= 0 ? end : undefined).trim();
  return title || null;
}

export class IcyDemuxer extends Transform {
  private remainingAudio: number;
  private expectingMetadataLength = false;
  private remainingMetadata = 0;
  private metadataParts: Buffer[] = [];

  constructor(private readonly metaint: number) {
    super({ highWaterMark: AUDIO_HIGH_WATER_MARK });
    if (!Number.isInteger(metaint) || metaint <= 0) {
      throw new Error("metaint ICY invalido");
    }
    this.remainingAudio = metaint;
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remainingAudio > 0) {
          const length = Math.min(this.remainingAudio, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + length));
          offset += length;
          this.remainingAudio -= length;
          if (this.remainingAudio === 0) this.expectingMetadataLength = true;
          continue;
        }

        if (this.expectingMetadataLength) {
          this.remainingMetadata = chunk[offset] * 16;
          offset += 1;
          this.expectingMetadataLength = false;
          if (this.remainingMetadata === 0) this.remainingAudio = this.metaint;
          else this.metadataParts = [];
          continue;
        }

        const length = Math.min(this.remainingMetadata, chunk.length - offset);
        this.metadataParts.push(chunk.subarray(offset, offset + length));
        offset += length;
        this.remainingMetadata -= length;
        if (this.remainingMetadata === 0) {
          this.emit("metadata", Buffer.concat(this.metadataParts));
          this.metadataParts = [];
          this.remainingAudio = this.metaint;
        }
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

export function openIcyStream(url: string, redirectDepth = 0): Promise<IcyHandle> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;
    let settled = false;
    const request = lib.get(
      parsedUrl,
      {
        headers: {
          "User-Agent": "discord-bot-nex/0.2",
          "Icy-MetaData": "1",
          Accept: "audio/*,*/*;q=0.8",
        },
      },
      (response) => {
        clearTimeout(openTimeout);
        const status = response.statusCode ?? 0;
        const location = headerValue(response.headers.location);
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume();
          response.destroy();
          if (redirectDepth >= MAX_REDIRECTS) {
            settled = true;
            reject(new Error("Demasiadas redirecciones en el stream"));
            return;
          }
          let nextUrl: string;
          try {
            nextUrl = new URL(location, parsedUrl).toString();
          } catch {
            settled = true;
            reject(new Error("El stream respondio con una redireccion invalida"));
            return;
          }
          settled = true;
          openIcyStream(nextUrl, redirectDepth + 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          response.destroy();
          settled = true;
          reject(new Error(`El stream respondio HTTP ${status}`));
          return;
        }

        const metaint = Number.parseInt(headerValue(response.headers["icy-metaint"]) ?? "", 10);
        if (Number.isFinite(metaint) && metaint > 0) {
          const demuxer = new IcyDemuxer(metaint);
          response.on("error", (error) => demuxer.destroy(error));
          response.pipe(demuxer);
          settled = true;
          resolve({ req: request, res: response, audioStream: demuxer, demuxer });
        } else {
          settled = true;
          resolve({ req: request, res: response, audioStream: response, demuxer: null });
        }
      },
    );
    const openTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error("Timeout abriendo el stream"));
    }, STREAM_OPEN_TIMEOUT_MS);
    request.on("error", (error) => {
      clearTimeout(openTimeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
