import assert from "node:assert/strict";
import test from "node:test";
import type { Artwork } from "../src/radio/artwork";
import {
  COLOR_LIVE,
  COLOR_OFFLINE,
  COLOR_WARNING,
  buildNowPlayingPayload,
  buildStatusEmbed,
  buildStoppedPayload,
  countdownTarget,
  formatDuration,
  stopReasonLabel,
  truncate,
  type NowPlayingView,
} from "../src/radio/nowPlayingView";

const cover: Artwork = {
  url: "https://img.example/a.jpg",
  data: Buffer.from("c"),
  fileName: "cover.jpg",
};
const logo: Artwork = { url: null, data: Buffer.from("l"), fileName: "logo.png" };
const ENDS_AT = 1_790_000_042_000;

function view(overrides: Partial<NowPlayingView> = {}): NowPlayingView {
  return {
    station: { name: "NEX", websiteUrl: "https://www.nex-radio.com/" },
    status: "playing",
    song: { title: "BbY WOW", artist: "KAROL G, Judeline" },
    extras: { endsAt: ENDS_AT, voted: false, votingOpen: false },
    listeners: 3,
    voiceChannelId: "123",
    cover,
    logo,
    ...overrides,
  };
}

function description(payload: ReturnType<typeof buildNowPlayingPayload>): string {
  return payload.embeds[0]?.toJSON().description ?? "";
}

test("la cuenta regresiva llega a cero 1 s despues del fin de la cancion", () => {
  assert.equal(countdownTarget(ENDS_AT), ENDS_AT + 1_000);
  assert.equal(countdownTarget(null), null);

  const countdown = `⏱️ Termina <t:${(ENDS_AT + 1_000) / 1000}:R>`;
  assert.ok(description(buildNowPlayingPayload(view(), ENDS_AT)).includes(countdown));
  assert.ok(description(buildNowPlayingPayload(view(), ENDS_AT + 999)).includes(countdown));
  // Desde fin + 1 s ya no se muestra, para no llegar a "hace X segundos".
  assert.ok(!description(buildNowPlayingPayload(view(), ENDS_AT + 1_000)).includes("Termina"));
});

test("la cuenta regresiva redondea hacia arriba al segundo", () => {
  const payload = buildNowPlayingPayload(
    view({ extras: { endsAt: 1_000_400, voted: false, votingOpen: false } }),
    0,
  );
  assert.ok(description(payload).includes("<t:1002:R>"));
});

test("arma el mensaje en vivo con portada, enlace, oyentes y boton", () => {
  const payload = buildNowPlayingPayload(view(), ENDS_AT - 60_000);
  const embed = payload.embeds[0]?.toJSON();
  assert.equal(embed?.color, COLOR_LIVE);
  assert.deepEqual(embed?.author, {
    name: "NEX · EN VIVO",
    icon_url: "attachment://logo.png",
    url: "https://www.nex-radio.com/",
  });
  assert.equal(embed?.title, "BbY WOW");
  assert.equal(embed?.url, "https://www.nex-radio.com/");
  assert.equal(embed?.thumbnail?.url, "attachment://cover.jpg");
  assert.equal(
    embed?.description,
    [
      "KAROL G, Judeline",
      "",
      `⏱️ Termina <t:${(ENDS_AT + 1_000) / 1000}:R>  ·  🎧 3 en <#123>`,
    ].join("\n"),
  );
  assert.deepEqual(
    payload.files.map((file) => file.name),
    ["cover.jpg", "logo.png"],
  );
  const button = payload.components[0]?.toJSON().components[0];
  assert.deepEqual(button, {
    type: 2,
    style: 5,
    label: "Escuchar en nex-radio.com",
    url: "https://www.nex-radio.com/",
    emoji: { animated: false, id: undefined, name: "🌐" },
  });
});

test("muestra la votacion y escapa el markdown del titulo", () => {
  const payload = buildNowPlayingPayload(
    view({
      song: { title: "*Tema*", artist: null },
      extras: { endsAt: null, voted: true, votingOpen: true },
    }),
  );
  const embed = payload.embeds[0]?.toJSON();
  assert.equal(embed?.title, "\\*Tema\\*");
  assert.equal(
    embed?.description,
    [
      "🎧 3 en <#123>",
      "🗳️ Elegida por votación de la comunidad",
      "🗳️ Votación abierta: elige la próxima en [nex-radio.com](https://www.nex-radio.com/)",
    ].join("\n"),
  );
});

test("mientras reconecta avisa y oculta la cuenta regresiva", () => {
  const payload = buildNowPlayingPayload(view({ status: "reconnecting" }), ENDS_AT - 60_000);
  const embed = payload.embeds[0]?.toJSON();
  assert.equal(embed?.color, COLOR_WARNING);
  assert.equal(embed?.author?.name, "NEX · RECONECTANDO");
  assert.equal(
    embed?.description,
    ["KAROL G, Judeline", "", "⚠️ Reconectando con la radio...", "🎧 3 en <#123>"].join("\n"),
  );
});

test("sin cancion, sin web y sin portada usa el logo", () => {
  const payload = buildNowPlayingPayload(
    view({
      station: { name: "Radio", websiteUrl: null },
      song: null,
      extras: { endsAt: null, voted: false, votingOpen: true },
      cover: null,
    }),
  );
  const embed = payload.embeds[0]?.toJSON();
  assert.equal(embed?.title, undefined);
  assert.equal(embed?.url, undefined);
  assert.equal(embed?.author?.name, "Radio · EN VIVO");
  assert.equal(embed?.author?.icon_url, "attachment://logo.png");
  assert.equal(embed?.author?.url, undefined);
  assert.equal(embed?.thumbnail?.url, "attachment://logo.png");
  assert.equal(
    embed?.description,
    ["_Esperando información de la canción..._", "", "🎧 3 en <#123>"].join("\n"),
  );
  assert.deepEqual(payload.components, []);
});

test("arma el mensaje de radio desconectada", () => {
  const payload = buildStoppedPayload(
    { name: "NEX", websiteUrl: "https://nex-radio.com/" },
    "idle_timeout",
    { title: "Patience", artist: "Guns N' Roses" },
    null,
    logo,
  );
  const embed = payload.embeds[0]?.toJSON();
  assert.equal(embed?.color, COLOR_OFFLINE);
  assert.equal(embed?.author?.name, "NEX · DESCONECTADA");
  assert.equal(embed?.title, "Radio desconectada");
  assert.equal(
    embed?.description,
    [
      "Motivo: canal sin oyentes.",
      "Última canción: **Patience** · Guns N' Roses",
      "",
      "Usa `/play` para volver a escucharla.",
    ].join("\n"),
  );
  assert.equal(embed?.thumbnail?.url, "attachment://logo.png");
  assert.equal(payload.components.length, 1);
});

test("arma el embed de /status", () => {
  const embed = buildStatusEmbed({
    stationName: "NEX",
    status: "playing",
    voiceChannelId: "123",
    listeners: 4,
    uptimeMs: 3_725_000,
    ping: { ws: 40, udp: undefined },
    voiceRetries: 1,
    streamRetries: 2,
    metadataSource: "json",
    lastAudioAt: 1_790_000_000_500,
    lastError: null,
  }).toJSON();
  assert.equal(embed.color, COLOR_LIVE);
  assert.equal(embed.title, "Estado — NEX");
  assert.deepEqual(
    embed.fields?.map((field) => `${field.name}: ${field.value}`),
    [
      "Estado: Reproduciendo",
      "Canal: <#123>",
      "Oyentes: 4",
      "Uptime: 1h 2m 5s",
      "Ping voz: WS 40 ms / UDP — ms",
      "Reintentos: Voz 1 / Stream 2",
      "Metadata: JSON",
      "Ultimo audio: <t:1790000000:R>",
    ],
  );

  const failing = buildStatusEmbed({
    stationName: "NEX",
    status: "reconnecting",
    voiceChannelId: "123",
    listeners: 0,
    uptimeMs: 0,
    ping: {},
    voiceRetries: 0,
    streamRetries: 3,
    metadataSource: null,
    lastAudioAt: null,
    lastError: "Timeout abriendo el stream",
  }).toJSON();
  assert.equal(failing.color, COLOR_WARNING);
  assert.equal(failing.fields?.at(-1)?.value, "Timeout abriendo el stream");
  assert.equal(failing.fields?.find((field) => field.name === "Metadata")?.value, "No disponible");
});

test("etiquetas y formatos auxiliares", () => {
  assert.equal(stopReasonLabel("command"), "comando /stop");
  assert.equal(stopReasonLabel("otro_motivo"), "otro_motivo");
  assert.equal(formatDuration(59_999), "0h 0m 59s");
  assert.equal(formatDuration(90_061_000), "25h 1m 1s");
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});
