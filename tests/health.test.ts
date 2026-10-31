import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import type { Client } from "discord.js";
import { HealthServer } from "../src/health";
import type { RadioManager } from "../src/radio/RadioManager";

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function fakeClient(ready: boolean, ping: number): Client {
  return { isReady: () => ready, ws: { ping } } as unknown as Client;
}

function fakeRadio(): RadioManager {
  return {
    getMetrics: () => ({
      sessions: 1,
      playingSessions: 1,
      reconnectingSessions: 0,
      streamFailures: 2,
      totalRetries: 3,
      metadataUpdates: 4,
      commands: { play: 5 },
    }),
  } as unknown as RadioManager;
}

test("HealthServer expone health JSON y metricas Prometheus", async () => {
  const port = await availablePort();
  const health = new HealthServer(fakeClient(true, 42), fakeRadio(), "127.0.0.1", port);
  await health.start();
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      status: "ok",
      discordReady: true,
      gatewayPingMs: 42,
      sessions: 1,
      playingSessions: 1,
      reconnectingSessions: 0,
      streamFailures: 2,
      totalRetries: 3,
      metadataUpdates: 4,
      commands: { play: 5 },
    });

    const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.match(
      metricsResponse.headers.get("content-type") ?? "",
      /^text\/plain; version=0\.0\.4/,
    );
    const metrics = await metricsResponse.text();
    assert.match(metrics, /discord_bot_nex_playing_sessions 1/);
    assert.match(metrics, /discord_bot_nex_stream_retries_total 3/);
    assert.match(metrics, /discord_bot_nex_commands_total\{command="play"\} 5/);

    const notFound = await fetch(`http://127.0.0.1:${port}/otra`);
    assert.equal(notFound.status, 404);
  } finally {
    await health.stop();
  }
});

test("HealthServer responde 503 mientras Discord no esta listo", async () => {
  const port = await availablePort();
  const health = new HealthServer(fakeClient(false, -1), fakeRadio(), "127.0.0.1", port);
  await health.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { status: string }).status, "starting");
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(metrics, /discord_bot_nex_up 0/);
    assert.match(metrics, /discord_bot_nex_gateway_ping_ms 0/);
  } finally {
    await health.stop();
  }
});

test("HealthServer no abre el puerto si HEALTH_PORT es 0", async () => {
  const health = new HealthServer(fakeClient(true, 1), fakeRadio(), "127.0.0.1", 0);
  await health.start();
  await health.stop();
});
