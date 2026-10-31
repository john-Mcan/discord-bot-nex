import { REST, Routes } from "discord.js";
import { env } from "./env";
import { commandsJson } from "./commands";

async function main() {
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

  const route = env.DEV_GUILD_ID
    ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DEV_GUILD_ID)
    : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

  console.log(
    env.DEV_GUILD_ID
      ? `[deploy:commands] Registrando comandos en guild ${env.DEV_GUILD_ID}...`
      : "[deploy:commands] Registrando comandos globalmente...",
  );

  await rest.put(route, { body: commandsJson });

  console.log("[deploy:commands] OK");
}

main().catch((err) => {
  console.error("[deploy:commands] Error:", err);
  process.exitCode = 1;
});
