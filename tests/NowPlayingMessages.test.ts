import assert from "node:assert/strict";
import test from "node:test";
import type { APIEmbed, Client, Message } from "discord.js";
import { MetadataTracker } from "../src/radio/MetadataTracker";
import { NowPlayingMessages, type NowPlayingContext } from "../src/radio/NowPlayingMessages";
import type { EmbedPayload } from "../src/radio/nowPlayingView";
import type { GuildSession } from "../src/radio/session";

type Sent = EmbedPayload & { content?: string; allowedMentions?: unknown };
type Edit = EmbedPayload & { attachments?: unknown[] };

function fakeDiscord(options: { failEdits?: boolean } = {}) {
  const sent: Sent[] = [];
  const edits: Edit[] = [];
  const message = {
    edit: (data: Edit) => {
      if (options.failEdits) return Promise.reject(new Error("Unknown Message"));
      edits.push(data);
      return Promise.resolve(message);
    },
  } as unknown as Message;
  const channel = {
    send: (data: Sent) => {
      sent.push(data);
      return Promise.resolve(message);
    },
  };
  const client = {
    channels: {
      cache: new Map([["text-1", channel]]),
      fetch: () => Promise.resolve(null),
    },
  } as unknown as Client;
  return { client, sent, edits, message };
}

function fakeSession(overrides: Partial<GuildSession> = {}): GuildSession {
  return {
    id: "s1",
    guildId: "g1",
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    createdAt: 0,
    status: "playing",
    nowPlayingRevision: 0,
    stopping: false,
    ...overrides,
  } as GuildSession;
}

function metadataTracker(): MetadataTracker {
  return new MetadataTracker({
    url: null,
    titlePath: null,
    artistPath: null,
    artworkPath: null,
    pollSeconds: 15,
    onChange: () => undefined,
  });
}

function context(overrides: Partial<NowPlayingContext> = {}): NowPlayingContext {
  return {
    station: () => ({ name: "NEX", websiteUrl: "https://nex-radio.com/" }),
    statusOf: (session) => session.status,
    listenerCount: () => Promise.resolve(2),
    ...overrides,
  };
}

function embedOf(payload: EmbedPayload | undefined): APIEmbed | undefined {
  return payload?.embeds[0]?.toJSON();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("envia el mensaje la primera vez y despues lo edita", async () => {
  const { client, sent, edits, message } = fakeDiscord();
  const metadata = metadataTracker();
  const messages = new NowPlayingMessages(client, metadata, context());
  const session = fakeSession();

  // Sin permiso para crear y sin mensaje previo, no hace nada.
  await messages.publish(session, false);
  assert.equal(sent.length, 0);

  await messages.publish(session, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.allowedMentions, { parse: [] });
  assert.equal(session.nowPlayingMessage, message);
  assert.equal(embedOf(sent[0])?.description?.includes("Esperando información"), true);
  // El logo de la radio va adjunto.
  assert.deepEqual(
    sent[0]?.files.map((file) => file.name),
    ["logo.png"],
  );

  metadata.handleIcyTitle("Artista - Tema");
  await messages.publish(session, false);
  assert.equal(sent.length, 1);
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0]?.attachments, []);
  assert.equal(embedOf(edits[0])?.title, "Tema");
});

test("agrupa las actualizaciones seguidas en una sola edicion", async () => {
  const { client, edits, message } = fakeDiscord();
  const messages = new NowPlayingMessages(client, metadataTracker(), context());
  const session = fakeSession({ nowPlayingMessage: message });

  messages.scheduleUpdate(session);
  messages.scheduleUpdate(session);
  messages.scheduleUpdate(session);
  await sleep(250);
  assert.equal(edits.length, 0);
  await sleep(200);
  assert.equal(edits.length, 1);

  // Sin mensaje o con la sesion cerrandose no programa nada.
  messages.scheduleUpdate(fakeSession());
  messages.scheduleUpdate(fakeSession({ nowPlayingMessage: message, stopping: true }));
  await sleep(400);
  assert.equal(edits.length, 1);
});

test("una actualizacion lenta no pisa a una mas nueva", async () => {
  const { client, edits, message } = fakeDiscord();
  const metadata = metadataTracker();
  let calls = 0;
  const messages = new NowPlayingMessages(
    client,
    metadata,
    context({
      // La primera tarda mas (como una portada que demora en bajar).
      listenerCount: () => {
        calls += 1;
        return sleep(calls === 1 ? 150 : 10).then(() => calls);
      },
    }),
  );
  const session = fakeSession({ nowPlayingMessage: message });

  const slow = messages.publish(session, false);
  const fast = messages.publish(session, false);
  await Promise.all([slow, fast]);
  assert.equal(edits.length, 1);
  assert.equal(embedOf(edits[0])?.description?.includes("🎧 2 en <#voice-1>"), true);
});

test("si la edicion falla olvida el mensaje", async () => {
  const { client, message } = fakeDiscord({ failEdits: true });
  const messages = new NowPlayingMessages(client, metadataTracker(), context());
  const session = fakeSession({ nowPlayingMessage: message });
  await messages.publish(session, false);
  assert.equal(session.nowPlayingMessage, undefined);
});

test("al detenerse deja el mensaje como radio desconectada", async () => {
  const { client, edits, message } = fakeDiscord();
  const metadata = metadataTracker();
  metadata.handleIcyTitle("Artista - Tema");
  const messages = new NowPlayingMessages(client, metadata, context());

  await messages.markStopped(fakeSession(), "command");
  assert.equal(edits.length, 0);

  await messages.markStopped(fakeSession({ nowPlayingMessage: message }), "command");
  const embed = embedOf(edits[0]);
  assert.equal(embed?.title, "Radio desconectada");
  assert.equal(embed?.description?.startsWith("Motivo: comando /stop."), true);
  assert.equal(embed?.description?.includes("**Tema** · Artista"), true);
  assert.deepEqual(edits[0]?.attachments, []);
});

test("los avisos de texto no mencionan a nadie y omiten sesiones que se cierran", async () => {
  const { client, sent } = fakeDiscord();
  const messages = new NowPlayingMessages(client, metadataTracker(), context());
  await messages.sendToAll(
    [fakeSession(), fakeSession({ id: "s2", stopping: true })],
    "La radio perdio la conexion. Reintentando (1/5)...",
  );
  assert.deepEqual(sent, [
    {
      content: "La radio perdio la conexion. Reintentando (1/5)...",
      allowedMentions: { parse: [] },
    },
  ]);
  // Un canal que no existe se ignora.
  await messages.sendText(fakeSession({ textChannelId: "otro" }), "hola");
  assert.equal(sent.length, 1);
});
