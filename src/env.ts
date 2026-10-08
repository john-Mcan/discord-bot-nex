import "dotenv/config";

function requiredString(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Falta variable de entorno obligatoria: ${name}`);
  }
  return value.trim();
}

function optionalString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function integerEnv(
  name: string,
  fallback: number,
  options: { min: number; max: number },
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    throw new Error(
      `${name} debe ser un entero entre ${options.min} y ${options.max}`,
    );
  }
  return value;
}

function httpUrlEnv(name: string, required: boolean): string | null {
  const raw = required ? requiredString(name) : optionalString(name);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} debe ser una URL valida`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} solo admite URLs http/https`);
  }
  return url.toString();
}

export const env = {
  DISCORD_TOKEN: requiredString("DISCORD_TOKEN"),
  DISCORD_CLIENT_ID: requiredString("DISCORD_CLIENT_ID"),
  DEV_GUILD_ID: optionalString("DEV_GUILD_ID"),
  RADIO_STREAM_URL: httpUrlEnv("RADIO_STREAM_URL", true) as string,
  RADIO_NAME: optionalString("RADIO_NAME"),
  RADIO_WEBSITE_URL: httpUrlEnv("RADIO_WEBSITE_URL", false),
  RADIO_METADATA_URL: httpUrlEnv("RADIO_METADATA_URL", false),
  RADIO_METADATA_TITLE_PATH: optionalString("RADIO_METADATA_TITLE_PATH"),
  RADIO_METADATA_ARTIST_PATH: optionalString("RADIO_METADATA_ARTIST_PATH"),
  RADIO_METADATA_ARTWORK_PATH: optionalString("RADIO_METADATA_ARTWORK_PATH"),
  METADATA_POLL_SECONDS: integerEnv("METADATA_POLL_SECONDS", 15, {
    min: 5,
    max: 300,
  }),
  IDLE_DISCONNECT_MINUTES: integerEnv("IDLE_DISCONNECT_MINUTES", 5, {
    min: 1,
    max: 1440,
  }),
  COMMAND_COOLDOWN_SECONDS: integerEnv("COMMAND_COOLDOWN_SECONDS", 3, {
    min: 0,
    max: 60,
  }),
  HEALTH_HOST: optionalString("HEALTH_HOST") ?? "127.0.0.1",
  HEALTH_PORT: integerEnv("HEALTH_PORT", 3000, { min: 0, max: 65535 }),
};


