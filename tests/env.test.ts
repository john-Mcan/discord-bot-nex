import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv, type EnvSource } from "../src/parseEnv";

const required: EnvSource = {
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "123",
  RADIO_STREAM_URL: "https://stream.example/radio.mp3",
};

test("parseEnv aplica los valores predeterminados", () => {
  assert.deepEqual(parseEnv(required), {
    DISCORD_TOKEN: "token",
    DISCORD_CLIENT_ID: "123",
    DEV_GUILD_ID: null,
    RADIO_STREAM_URL: "https://stream.example/radio.mp3",
    RADIO_NAME: null,
    RADIO_WEBSITE_URL: null,
    RADIO_METADATA_URL: null,
    RADIO_METADATA_TITLE_PATH: null,
    RADIO_METADATA_ARTIST_PATH: null,
    RADIO_METADATA_ARTWORK_PATH: null,
    METADATA_POLL_SECONDS: 15,
    IDLE_DISCONNECT_MINUTES: 5,
    COMMAND_COOLDOWN_SECONDS: 3,
    HEALTH_HOST: "127.0.0.1",
    HEALTH_PORT: 3000,
  });
});

test("parseEnv exige las variables obligatorias", () => {
  for (const name of ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "RADIO_STREAM_URL"]) {
    assert.throws(
      () => parseEnv({ ...required, [name]: undefined }),
      new RegExp(`Falta variable de entorno obligatoria: ${name}`),
    );
    assert.throws(() => parseEnv({ ...required, [name]: "   " }), /Falta variable/);
  }
});

test("parseEnv recorta espacios y trata los textos vacios como no definidos", () => {
  const env = parseEnv({
    ...required,
    DISCORD_TOKEN: "  token  ",
    RADIO_NAME: "  NEX  ",
    DEV_GUILD_ID: "   ",
    HEALTH_HOST: "",
  });
  assert.equal(env.DISCORD_TOKEN, "token");
  assert.equal(env.RADIO_NAME, "NEX");
  assert.equal(env.DEV_GUILD_ID, null);
  assert.equal(env.HEALTH_HOST, "127.0.0.1");
});

test("parseEnv valida y normaliza las URLs", () => {
  const env = parseEnv({
    ...required,
    RADIO_WEBSITE_URL: "https://nex-radio.com",
    RADIO_METADATA_URL: " https://api.nex-radio.com/api/radio/snapshot ",
  });
  assert.equal(env.RADIO_WEBSITE_URL, "https://nex-radio.com/");
  assert.equal(env.RADIO_METADATA_URL, "https://api.nex-radio.com/api/radio/snapshot");
  assert.throws(
    () => parseEnv({ ...required, RADIO_STREAM_URL: "no es url" }),
    /RADIO_STREAM_URL debe ser una URL valida/,
  );
  assert.throws(
    () => parseEnv({ ...required, RADIO_METADATA_URL: "ftp://example.com/a" }),
    /RADIO_METADATA_URL solo admite URLs http\/https/,
  );
});

test("parseEnv valida los enteros y sus rangos", () => {
  const env = parseEnv({
    ...required,
    METADATA_POLL_SECONDS: "5",
    IDLE_DISCONNECT_MINUTES: "1440",
    COMMAND_COOLDOWN_SECONDS: "0",
    HEALTH_PORT: "0",
  });
  assert.equal(env.METADATA_POLL_SECONDS, 5);
  assert.equal(env.IDLE_DISCONNECT_MINUTES, 1440);
  assert.equal(env.COMMAND_COOLDOWN_SECONDS, 0);
  assert.equal(env.HEALTH_PORT, 0);

  assert.throws(
    () => parseEnv({ ...required, METADATA_POLL_SECONDS: "4" }),
    /METADATA_POLL_SECONDS debe ser un entero entre 5 y 300/,
  );
  assert.throws(
    () => parseEnv({ ...required, IDLE_DISCONNECT_MINUTES: "1.5" }),
    /IDLE_DISCONNECT_MINUTES debe ser un entero/,
  );
  assert.throws(
    () => parseEnv({ ...required, COMMAND_COOLDOWN_SECONDS: "61" }),
    /COMMAND_COOLDOWN_SECONDS debe ser un entero entre 0 y 60/,
  );
  assert.throws(() => parseEnv({ ...required, HEALTH_PORT: "puerto" }), /HEALTH_PORT/);
  assert.throws(() => parseEnv({ ...required, HEALTH_PORT: "65536" }), /HEALTH_PORT/);
});
