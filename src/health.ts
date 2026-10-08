import type { Client } from "discord.js";
import { createServer, type Server } from "node:http";
import { logger } from "./logger";
import type { RadioManager } from "./radio/RadioManager";

export class HealthServer {
  private server?: Server;

  constructor(
    private readonly client: Client,
    private readonly radio: RadioManager,
    private readonly host: string,
    private readonly port: number,
  ) {}

  public async start(): Promise<void> {
    if (this.port === 0) {
      logger.info("health.disabled");
      return;
    }
    this.server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/healthz") {
        const healthy = this.client.isReady();
        response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          status: healthy ? "ok" : "starting",
          discordReady: healthy,
          gatewayPingMs: this.client.ws.ping,
          ...this.radio.getMetrics(),
        }));
        return;
      }
      if (path === "/metrics") {
        response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        response.end(this.prometheusMetrics());
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) return reject(new Error("No se pudo crear el servidor de healthcheck"));
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.port, this.host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    logger.info("health.listening", { host: this.host, port: this.port });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private prometheusMetrics(): string {
    const metrics = this.radio.getMetrics();
    const lines = [
      "# HELP discord_bot_nex_up Whether the Discord client is ready.",
      "# TYPE discord_bot_nex_up gauge",
      `discord_bot_nex_up ${this.client.isReady() ? 1 : 0}`,
      "# HELP discord_bot_nex_gateway_ping_ms Discord gateway ping in milliseconds.",
      "# TYPE discord_bot_nex_gateway_ping_ms gauge",
      `discord_bot_nex_gateway_ping_ms ${Math.max(0, this.client.ws.ping)}`,
      "# TYPE discord_bot_nex_sessions gauge",
      `discord_bot_nex_sessions ${metrics.sessions}`,
      "# TYPE discord_bot_nex_playing_sessions gauge",
      `discord_bot_nex_playing_sessions ${metrics.playingSessions}`,
      "# TYPE discord_bot_nex_reconnecting_sessions gauge",
      `discord_bot_nex_reconnecting_sessions ${metrics.reconnectingSessions}`,
      "# TYPE discord_bot_nex_stream_failures_total counter",
      `discord_bot_nex_stream_failures_total ${metrics.streamFailures}`,
      "# TYPE discord_bot_nex_stream_retries_total counter",
      `discord_bot_nex_stream_retries_total ${metrics.totalRetries}`,
      "# TYPE discord_bot_nex_metadata_updates_total counter",
      `discord_bot_nex_metadata_updates_total ${metrics.metadataUpdates}`,
    ];
    for (const [command, count] of Object.entries(metrics.commands)) {
      const safeCommand = command.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`discord_bot_nex_commands_total{command="${safeCommand}"} ${count}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
