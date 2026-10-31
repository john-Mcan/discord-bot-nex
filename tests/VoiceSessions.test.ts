import assert from "node:assert/strict";
import test from "node:test";
import {
  VoiceConnectionStatus,
  createAudioPlayer,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import type { Client, VoiceState } from "discord.js";
import type { Broadcast } from "../src/radio/Broadcast";
import type { NowPlayingMessages } from "../src/radio/NowPlayingMessages";
import { VoiceSessions } from "../src/radio/VoiceSessions";

const BOT_ID = "bot";

// Adaptador de voz que no habla con Discord: la conexion queda en
// "signalling", suficiente para probar el ciclo de vida de la sesion.
const fakeAdapter: DiscordGatewayAdapterCreator = () => ({
  sendPayload: () => true,
  destroy: () => undefined,
});

function setup(options: { humans?: number } = {}) {
  let humans = options.humans ?? 1;
  type Member = { user: { bot: boolean } };
  // Imita la Collection de discord.js: solo se usa filter(...).size.
  const voiceChannel = {
    isVoiceBased: () => true,
    get members() {
      const all: Member[] = [
        ...Array.from({ length: humans }, () => ({ user: { bot: false } })),
        { user: { bot: true } },
      ];
      return { filter: (fn: (member: Member) => boolean) => ({ size: all.filter(fn).length }) };
    },
  };
  const guild = {
    channels: { cache: new Map([["voice-1", voiceChannel]]), fetch: () => Promise.resolve(null) },
    voiceStates: { cache: new Map() },
  };
  const client = {
    user: { id: BOT_ID },
    guilds: { cache: new Map([["g1", guild]]) },
  } as unknown as Client;

  const texts: string[] = [];
  const stopped: string[] = [];
  let shutdowns = 0;
  let closed = 0;
  const player = createAudioPlayer();
  const broadcast = {
    ensurePlayer: () => player,
    ensure: () => Promise.resolve(),
    scheduleShutdown: () => {
      shutdowns += 1;
    },
  } as unknown as Broadcast;
  const messages = {
    sendText: (_session: unknown, content: string) => {
      texts.push(content);
      return Promise.resolve();
    },
    scheduleUpdate: () => undefined,
    markStopped: (_session: unknown, reason: string) => {
      stopped.push(reason);
      return Promise.resolve();
    },
  } as unknown as NowPlayingMessages;

  const sessions = new VoiceSessions(
    client,
    { idleDisconnectMinutes: 1 },
    broadcast,
    messages,
    () => {
      closed += 1;
    },
  );
  const create = (guildId = "g1") =>
    sessions.create({
      guildId,
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      adapterCreator: fakeAdapter,
    });
  return {
    sessions,
    create,
    texts,
    stopped,
    setHumans: (count: number) => {
      humans = count;
    },
    counters: () => ({ shutdowns, closed }),
  };
}

function voiceState(id: string, channelId: string | null): VoiceState {
  return { id, channelId, guild: { id: "g1" } } as unknown as VoiceState;
}

// Deja correr las promesas pendientes sin avanzar los temporizadores simulados.
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("crea la sesion suscrita al reproductor compartido y la cierra en orden", async () => {
  const { sessions, create, stopped, counters } = setup();
  const session = create();
  assert.equal(sessions.size, 1);
  assert.equal(sessions.get("g1"), session);
  assert.equal(session.status, "connecting");
  assert.ok(session.subscription);

  const first = sessions.stop(session, "command");
  const second = sessions.stop(session, "otra");
  await Promise.all([first, second]);
  assert.equal(session.status, "stopped");
  assert.equal(session.stopping, true);
  assert.equal(session.connection.state.status, VoiceConnectionStatus.Destroyed);
  assert.equal(sessions.size, 0);
  // Se cierra una sola vez, con el primer motivo.
  assert.deepEqual(stopped, ["command"]);
  assert.deepEqual(counters(), { shutdowns: 1, closed: 1 });
});

test("si sacan al bot del canal, la sesion se cierra como desconexion manual", async () => {
  const { sessions, create, stopped } = setup();
  const session = create("g1");
  sessions.handleVoiceStateUpdate(voiceState(BOT_ID, "voice-1"), voiceState(BOT_ID, "voice-2"));
  await session.stopPromise;
  assert.deepEqual(stopped, ["manual_disconnect"]);
  assert.equal(sessions.size, 0);
});

test("cuenta solo a las personas del canal, no a los bots", async () => {
  const { sessions, create, setHumans } = setup({ humans: 3 });
  const session = create();
  assert.equal(await sessions.listenerCount(session), 3);
  setHumans(0);
  assert.equal(await sessions.listenerCount(session), 0);
  await sessions.stop(session, "command");
});

test("sin oyentes avisa y se desconecta al cumplirse el plazo", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessions, create, texts, stopped, setHumans } = setup({ humans: 0 });
  const session = create();

  sessions.requestIdleRefresh(session);
  await flush();
  assert.deepEqual(texts, [
    "No hay usuarios escuchando. Me desconectare en 1 min si nadie vuelve.",
  ]);
  assert.ok(session.idleTimer);

  // Alguien entra antes del plazo: se cancela.
  setHumans(1);
  sessions.handleVoiceStateUpdate(voiceState("user-0", null), voiceState("user-0", "voice-1"));
  await flush();
  assert.equal(session.idleTimer, undefined);
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(stopped, []);

  // Se va de nuevo y nadie vuelve en 1 minuto.
  setHumans(0);
  sessions.handleVoiceStateUpdate(voiceState("user-0", "voice-1"), voiceState("user-0", null));
  await flush();
  t.mock.timers.tick(59_999);
  await flush();
  assert.deepEqual(stopped, []);
  t.mock.timers.tick(1);
  await flush();
  await session.stopPromise;
  assert.equal(texts.at(-1), "No hay usuarios escuchando. Hasta pronto.");
  assert.deepEqual(stopped, ["idle_timeout"]);
});
