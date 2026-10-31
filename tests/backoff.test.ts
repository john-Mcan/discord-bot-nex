import assert from "node:assert/strict";
import test from "node:test";
import { MAX_START_ATTEMPTS, retryDelayMs, sleep } from "../src/radio/backoff";

test("retryDelayMs duplica la espera en cada intento hasta 24 s", () => {
  const noJitter = () => 0;
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, noJitter)),
    [1_500, 3_000, 6_000, 12_000, 24_000],
  );
  // Despues del quinto intento ya no crece.
  assert.equal(retryDelayMs(6, noJitter), 24_000);
  assert.equal(retryDelayMs(20, noJitter), 24_000);
});

test("retryDelayMs agrega hasta 750 ms de variacion aleatoria", () => {
  assert.equal(
    retryDelayMs(1, () => 0.5),
    1_875,
  );
  assert.equal(
    retryDelayMs(1, () => 0.9999),
    2_249,
  );
  for (let i = 0; i < 200; i += 1) {
    const delay = retryDelayMs(3);
    assert.ok(delay >= 6_000 && delay < 6_750, `fuera de rango: ${delay}`);
  }
});

test("la espera total de los reintentos queda bajo un minuto", () => {
  // En una recuperacion esperan los cinco intentos (en el arranque, el primero no).
  let worstCase = 0;
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
    worstCase += retryDelayMs(attempt, () => 0.9999);
  }
  assert.equal(MAX_START_ATTEMPTS, 5);
  assert.ok(worstCase < 60_000, `espera total ${worstCase} ms`);
});

test("sleep resuelve despues del tiempo indicado", async () => {
  const startedAt = Date.now();
  await sleep(30);
  assert.ok(Date.now() - startedAt >= 25);
});
