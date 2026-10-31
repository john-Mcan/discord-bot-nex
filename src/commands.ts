import { SlashCommandBuilder } from "discord.js";

const playCommand = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Llama al bot a tu canal de voz y reproduce la radio configurada");

const radioCommand = new SlashCommandBuilder()
  .setName("radio")
  .setDescription("Alias de /play (reproduce la radio configurada)");

const stopCommand = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Detiene la radio y desconecta el bot");

const leaveCommand = new SlashCommandBuilder()
  .setName("leave")
  .setDescription("Alias de /stop (desconecta el bot)");

const nowPlayingCommand = new SlashCommandBuilder()
  .setName("nowplaying")
  .setDescription("Muestra la cancion que esta sonando");

const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Muestra el estado de la radio y la conexion");

export const commands = [
  playCommand,
  radioCommand,
  stopCommand,
  leaveCommand,
  nowPlayingCommand,
  statusCommand,
];
export const commandsJson = commands.map((c) => c.toJSON());
