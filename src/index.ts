import ffmpegPath from "ffmpeg-static";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { env } from "./env";
import { HealthServer } from "./health";
import { logger } from "./logger";
import { RadioManager } from "./radio/RadioManager";

if (ffmpegPath && !process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = ffmpegPath;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const radio = new RadioManager(client, {
  streamUrl: env.RADIO_STREAM_URL,
  stationName: env.RADIO_NAME,
  websiteUrl: env.RADIO_WEBSITE_URL,
  idleDisconnectMinutes: env.IDLE_DISCONNECT_MINUTES,
  metadataUrl: env.RADIO_METADATA_URL,
  metadataTitlePath: env.RADIO_METADATA_TITLE_PATH,
  metadataArtistPath: env.RADIO_METADATA_ARTIST_PATH,
  metadataArtworkPath: env.RADIO_METADATA_ARTWORK_PATH,
  metadataPollSeconds: env.METADATA_POLL_SECONDS,
});
const health = new HealthServer(client, radio, env.HEALTH_HOST, env.HEALTH_PORT);
const cooldowns = new Map<string, number>();
let shuttingDown = false;

function canonicalCommand(command: string): string {
  if (command === "radio") return "play";
  if (command === "leave") return "stop";
  return command;
}

client.once(Events.ClientReady, (readyClient) => {
  logger.info("discord.ready", {
    userId: readyClient.user.id,
    userTag: readyClient.user.tag,
    guilds: readyClient.guilds.cache.size,
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = canonicalCommand(interaction.commandName);
  if (!["play", "stop", "nowplaying", "status"].includes(command)) return;

  radio.recordCommand(command);
  const cooldownKey = `${interaction.guildId ?? "dm"}:${interaction.user.id}:${command}`;
  const now = Date.now();
  const availableAt = cooldowns.get(cooldownKey) ?? 0;
  if (now < availableAt) {
    const remaining = Math.max(1, Math.ceil((availableAt - now) / 1000));
    await interaction.reply({
      content: `Espera ${remaining}s antes de volver a usar este comando.`,
      ephemeral: true,
    }).catch(() => null);
    return;
  }
  if (env.COMMAND_COOLDOWN_SECONDS > 0) {
    cooldowns.set(cooldownKey, now + env.COMMAND_COOLDOWN_SECONDS * 1000);
  }
  if (cooldowns.size > 10_000) {
    for (const [key, expiresAt] of cooldowns) if (expiresAt <= now) cooldowns.delete(key);
  }

  logger.info("command.received", {
    command,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
  });
  try {
    if (command === "play") await radio.play(interaction);
    else if (command === "stop") await radio.stop(interaction);
    else if (command === "nowplaying") await radio.nowPlaying(interaction);
    else await radio.status(interaction);
  } catch (error) {
    logger.error("command.failed", {
      command,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Ocurrio un error al procesar el comando.", ephemeral: true }).catch(() => null);
    } else if (interaction.deferred) {
      await interaction.editReply("Ocurrio un error al procesar el comando.").catch(() => null);
    }
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  radio.onVoiceStateUpdate(oldState, newState);
});

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("process.shutdown", { signal, exitCode });
  await health.stop().catch(() => null);
  await radio.shutdown().catch((error) => {
    logger.error("radio.shutdown_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  client.destroy();
  process.exitCode = exitCode;
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  logger.error("process.unhandled_rejection", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
});
process.on("uncaughtException", (error) => {
  logger.error("process.uncaught_exception", { error: error.stack ?? error.message });
  void shutdown("uncaughtException", 1);
});

async function main(): Promise<void> {
  await client.login(env.DISCORD_TOKEN);
  await health.start();
}

main().catch(async (error) => {
  logger.error("process.fatal", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  await shutdown("fatal", 1);
});
