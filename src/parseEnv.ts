export type EnvSource = Record<string, string | undefined>;

function requiredString(source: EnvSource, name: string): string {
  const value = source[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Falta variable de entorno obligatoria: ${name}`);
  }
  return value.trim();
}

function optionalString(source: EnvSource, name: string): string | null {
  const value = source[name]?.trim();
  return value ? value : null;
}

function integerEnv(
  source: EnvSource,
  name: string,
  fallback: number,
  options: { min: number; max: number },
): number {
  const raw = source[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    throw new Error(
      `${name} debe ser un entero entre ${options.min} y ${options.max}`,
    );
  }
  return value;
}

function httpUrlEnv(source: EnvSource, name: string, required: boolean): string | null {
  const raw = required ? requiredString(source, name) : optionalString(source, name);
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

// Valida las variables de entorno y aplica los valores predeterminados.
// No lee process.env por su cuenta para poder probarla sin un .env real.
export function parseEnv(source: EnvSource) {
  return {
    DISCORD_TOKEN: requiredString(source, "DISCORD_TOKEN"),
    DISCORD_CLIENT_ID: requiredString(source, "DISCORD_CLIENT_ID"),
    DEV_GUILD_ID: optionalString(source, "DEV_GUILD_ID"),
    RADIO_STREAM_URL: httpUrlEnv(source, "RADIO_STREAM_URL", true) as string,
    RADIO_NAME: optionalString(source, "RADIO_NAME"),
    RADIO_WEBSITE_URL: httpUrlEnv(source, "RADIO_WEBSITE_URL", false),
    RADIO_METADATA_URL: httpUrlEnv(source, "RADIO_METADATA_URL", false),
    RADIO_METADATA_TITLE_PATH: optionalString(source, "RADIO_METADATA_TITLE_PATH"),
    RADIO_METADATA_ARTIST_PATH: optionalString(source, "RADIO_METADATA_ARTIST_PATH"),
    RADIO_METADATA_ARTWORK_PATH: optionalString(source, "RADIO_METADATA_ARTWORK_PATH"),
    METADATA_POLL_SECONDS: integerEnv(source, "METADATA_POLL_SECONDS", 15, {
      min: 5,
      max: 300,
    }),
    IDLE_DISCONNECT_MINUTES: integerEnv(source, "IDLE_DISCONNECT_MINUTES", 5, {
      min: 1,
      max: 1440,
    }),
    COMMAND_COOLDOWN_SECONDS: integerEnv(source, "COMMAND_COOLDOWN_SECONDS", 3, {
      min: 0,
      max: 60,
    }),
    HEALTH_HOST: optionalString(source, "HEALTH_HOST") ?? "127.0.0.1",
    HEALTH_PORT: integerEnv(source, "HEALTH_PORT", 3000, { min: 0, max: 65535 }),
  };
}

export type Env = ReturnType<typeof parseEnv>;
