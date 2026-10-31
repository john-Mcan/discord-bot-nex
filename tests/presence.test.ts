import assert from "node:assert/strict";
import test from "node:test";
import type { Client, PresenceData } from "discord.js";
import { Presence } from "../src/radio/presence";

function fakeClient() {
  const calls: PresenceData[] = [];
  const client = {
    user: { setPresence: (data: PresenceData) => calls.push(data) },
  } as unknown as Client;
  const names = () => calls.map((call) => call.activities?.[0]?.name);
  return { client, calls, names };
}

test("publica la cancion como maximo una vez cada 10 s", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { client, names } = fakeClient();
  const presence = new Presence(client);

  presence.schedule("Tema 1");
  assert.deepEqual(names(), ["Tema 1"]);

  // Dentro de los 10 s se acumula y solo sale la ultima.
  t.mock.timers.tick(2_000);
  presence.schedule("Tema 2");
  presence.schedule("Tema 3");
  assert.deepEqual(names(), ["Tema 1"]);
  t.mock.timers.tick(7_999);
  assert.deepEqual(names(), ["Tema 1"]);
  t.mock.timers.tick(1);
  assert.deepEqual(names(), ["Tema 1", "Tema 3"]);

  // El mismo titulo no se vuelve a publicar.
  t.mock.timers.tick(10_000);
  presence.schedule("Tema 3");
  assert.deepEqual(names(), ["Tema 1", "Tema 3"]);
});

test("sin sesiones vuelve a la invitacion a usar /play", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { client, calls, names } = fakeClient();
  const presence = new Presence(client);

  presence.sync("Tema");
  presence.sync(null);
  assert.deepEqual(names(), ["Tema", "dale /play a NEX!"]);
  assert.equal(calls[1]?.status, "online");

  // Despues de reiniciar, la misma cancion se vuelve a mostrar.
  t.mock.timers.tick(10_000);
  presence.sync("Tema");
  assert.deepEqual(names(), ["Tema", "dale /play a NEX!", "Tema"]);
});

test("recorta el titulo a 128 caracteres y dispose cancela lo pendiente", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { client, names } = fakeClient();
  const presence = new Presence(client);

  presence.schedule("x".repeat(200));
  assert.equal(names()[0]?.length, 128);

  presence.schedule("Pendiente");
  presence.dispose();
  t.mock.timers.tick(20_000);
  assert.equal(names().length, 1);
});
