// Presentacion en Discord: el mensaje "sonando ahora", el mensaje de radio
// desconectada y el embed de /status. Funciones puras: reciben los datos ya
// resueltos y no hacen red.
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
} from "discord.js";
import type { Artwork } from "./artwork";
import type { MetadataExtras, SongInfo } from "./metadata";
import type { SessionStatus } from "./session";

// Colores de la marca NEX (los mismos de la web).
export const COLOR_LIVE = 0xff0ea2;
export const COLOR_WARNING = 0xfffc00;
export const COLOR_OFFLINE = 0x818192;
// La cuenta regresiva llega a cero cuando cambia el audio: la siguiente
// cancion empieza 1 s despues del ends_at de la anterior.
const COUNTDOWN_DISPLAY_LAG_MS = 1_000;

export type Station = {
  name: string;
  websiteUrl: string | null;
};

export type EmbedPayload = {
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
};

export type NowPlayingView = {
  station: Station;
  status: SessionStatus;
  song: SongInfo | null;
  extras: MetadataExtras;
  listeners: number;
  voiceChannelId: string;
  cover: Artwork | null;
  logo: Artwork | null;
};

export type StatusView = {
  stationName: string;
  status: SessionStatus;
  voiceChannelId: string;
  listeners: number;
  uptimeMs: number;
  ping: { ws?: number; udp?: number };
  voiceRetries: number;
  streamRetries: number;
  metadataSource: string | null;
  lastAudioAt: number | null;
  lastError: string | null;
};

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Momento en que la cuenta regresiva del mensaje llega a cero.
export function countdownTarget(endsAt: number | null): number | null {
  return endsAt ? endsAt + COUNTDOWN_DISPLAY_LAG_MS : null;
}

export function buildNowPlayingPayload(view: NowPlayingView, now = Date.now()): EmbedPayload {
  const { station, status, song, extras, cover, logo } = view;
  const live = status === "playing";
  const embed = new EmbedBuilder()
    .setColor(live ? COLOR_LIVE : COLOR_WARNING)
    .setAuthor(authorLine(station, live ? "EN VIVO" : statusLabel(status).toUpperCase(), logo));

  const lines: string[] = [];
  if (!song) lines.push("_Esperando información de la canción..._");
  else {
    embed.setTitle(truncate(escapeMarkdown(song.title), 256));
    if (station.websiteUrl) embed.setURL(station.websiteUrl);
    if (song.artist) lines.push(truncate(escapeMarkdown(song.artist), 512));
  }
  if (lines.length > 0) lines.push("");
  if (!live) lines.push(`⚠️ ${statusLabel(status)} con la radio...`);
  const details: string[] = [];
  const countdownAt = countdownTarget(extras.endsAt);
  if (live && countdownAt && countdownAt > now) {
    // Discord actualiza la cuenta regresiva solo, sin editar el mensaje.
    details.push(`⏱️ Termina <t:${Math.ceil(countdownAt / 1000)}:R>`);
  }
  details.push(`🎧 ${view.listeners} en <#${view.voiceChannelId}>`);
  lines.push(details.join("  ·  "));
  if (extras.voted) lines.push("🗳️ Elegida por votación de la comunidad");
  if (extras.votingOpen && station.websiteUrl) {
    lines.push(
      `🗳️ Votación abierta: elige la próxima en [${websiteLabel(station.websiteUrl)}](${station.websiteUrl})`,
    );
  }
  embed.setDescription(lines.join("\n"));
  return {
    embeds: [embed],
    files: attachImages(embed, cover, logo),
    components: linkButtons(station.websiteUrl),
  };
}

export function buildStoppedPayload(
  station: Station,
  reason: string,
  song: SongInfo | null,
  cover: Artwork | null,
  logo: Artwork | null,
): EmbedPayload {
  const lines = [`Motivo: ${stopReasonLabel(reason)}.`];
  if (song) {
    const artist = song.artist ? ` · ${escapeMarkdown(song.artist)}` : "";
    lines.push(truncate(`Última canción: **${escapeMarkdown(song.title)}**${artist}`, 1024));
  }
  lines.push("", "Usa `/play` para volver a escucharla.");
  const embed = new EmbedBuilder()
    .setColor(COLOR_OFFLINE)
    .setAuthor(authorLine(station, "DESCONECTADA", logo))
    .setTitle("Radio desconectada")
    .setDescription(lines.join("\n"));
  const files = attachImages(embed, cover, logo);
  return { embeds: [embed], files, components: linkButtons(station.websiteUrl) };
}

export function buildStatusEmbed(view: StatusView): EmbedBuilder {
  const { status, ping, lastError } = view;
  const embed = new EmbedBuilder()
    .setColor(status === "playing" ? COLOR_LIVE : COLOR_WARNING)
    .setTitle(`Estado — ${view.stationName}`)
    .addFields(
      { name: "Estado", value: statusLabel(status), inline: true },
      { name: "Canal", value: `<#${view.voiceChannelId}>`, inline: true },
      { name: "Oyentes", value: String(view.listeners), inline: true },
      { name: "Uptime", value: formatDuration(view.uptimeMs), inline: true },
      {
        name: "Ping voz",
        value: `WS ${ping.ws ?? "—"} ms / UDP ${ping.udp ?? "—"} ms`,
        inline: true,
      },
      {
        name: "Reintentos",
        value: `Voz ${view.voiceRetries} / Stream ${view.streamRetries}`,
        inline: true,
      },
      {
        name: "Metadata",
        value: view.metadataSource?.toUpperCase() ?? "No disponible",
        inline: true,
      },
      {
        name: "Ultimo audio",
        value: view.lastAudioAt ? `<t:${Math.floor(view.lastAudioAt / 1000)}:R>` : "—",
        inline: true,
      },
    )
    .setTimestamp();
  if (lastError) embed.addFields({ name: "Ultimo error", value: lastError.slice(0, 1024) });
  return embed;
}

export function statusLabel(status: SessionStatus): string {
  return {
    connecting: "Conectando",
    playing: "Reproduciendo",
    reconnecting: "Reconectando",
    stopping: "Desconectando",
    stopped: "Desconectada",
  }[status];
}

export function stopReasonLabel(reason: string): string {
  return (
    {
      command: "comando /stop",
      manual_disconnect: "desconexión manual desde Discord",
      idle_timeout: "canal sin oyentes",
      retries_exhausted: "fallos de conexión",
      start_failed: "no se pudo iniciar",
      shutdown: "apagado del bot",
      replaced: "sesión trasladada",
      connection_destroyed: "conexión cerrada",
    }[reason] ?? reason
  );
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}h ${minutes}m ${remainder}s`;
}

function authorLine(
  station: Station,
  state: string,
  logo: Artwork | null,
): { name: string; iconURL?: string; url?: string } {
  return {
    name: truncate(`${station.name} · ${state}`, 256),
    ...(logo ? { iconURL: `attachment://${logo.fileName}` } : {}),
    ...(station.websiteUrl ? { url: station.websiteUrl } : {}),
  };
}

function linkButtons(websiteUrl: string | null): ActionRowBuilder<ButtonBuilder>[] {
  if (!websiteUrl) return [];
  const button = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel(`Escuchar en ${websiteLabel(websiteUrl)}`)
    .setURL(websiteUrl)
    .setEmoji("🌐");
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(button)];
}

function websiteLabel(websiteUrl: string | null): string {
  try {
    return new URL(websiteUrl ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "la web";
  }
}

// Las imagenes se suben como adjuntos en vez de enlazar URLs: asi Discord no
// depende de su proxy de imagenes externas, que a veces falla al descargarlas
// y deja el embed sin portada.
function attachImages(
  embed: EmbedBuilder,
  cover: Artwork | null,
  logo: Artwork | null,
): AttachmentBuilder[] {
  const files = [cover, logo]
    .filter((image): image is Artwork => image !== null)
    .map((image) => new AttachmentBuilder(image.data, { name: image.fileName }));
  const thumbnail = cover ?? logo;
  if (thumbnail) embed.setThumbnail(`attachment://${thumbnail.fileName}`);
  return files;
}
