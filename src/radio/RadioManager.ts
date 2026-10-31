// Fachada del bot de radio: atiende los comandos (/play, /stop, /nowplaying y
// /status) y los eventos de voz, y conecta la transmision compartida, la
// metadata, los mensajes, la presencia y las sesiones por servidor.
import {
  ChannelType,
  GuildMember,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type VoiceState,
} from "discord.js";
import { errorMessage } from "../errors";
import { logger } from "../logger";
import { Broadcast } from "./Broadcast";
import { inferAzuraCastMetadataUrl } from "./metadata";
import { MetadataTracker, type MetadataChange } from "./MetadataTracker";
import { NowPlayingMessages } from "./NowPlayingMessages";
import { buildStatusEmbed, statusLabel } from "./nowPlayingView";
import { Presence } from "./presence";
import { effectiveStatus, sessionContext, type GuildSession, type SessionStatus } from "./session";
import { VoiceSessions } from "./VoiceSessions";

export type RadioManagerConfig = {
  streamUrl: string;
  stationName: string | null;
  websiteUrl: string | null;
  idleDisconnectMinutes: number;
  metadataUrl: string | null;
  metadataTitlePath: string | null;
  metadataArtistPath: string | null;
  metadataArtworkPath: string | null;
  metadataPollSeconds: number;
};

export type RadioMetrics = {
  sessions: number;
  playingSessions: number;
  reconnectingSessions: number;
  streamFailures: number;
  totalRetries: number;
  metadataUpdates: number;
  commands: Record<string, number>;
};

export class RadioManager {
  private readonly commandCounts = new Map<string, number>();
  private readonly metadata: MetadataTracker;
  private readonly presence: Presence;
  private readonly broadcast: Broadcast;
  private readonly messages: NowPlayingMessages;
  private readonly sessions: VoiceSessions;

  constructor(
    private readonly client: Client,
    private readonly config: RadioManagerConfig,
  ) {
    this.presence = new Presence(client);
    this.metadata = new MetadataTracker({
      url: config.metadataUrl ?? inferAzuraCastMetadataUrl(config.streamUrl),
      titlePath: config.metadataTitlePath,
      artistPath: config.metadataArtistPath,
      artworkPath: config.metadataArtworkPath,
      pollSeconds: config.metadataPollSeconds,
      onChange: (change) => this.onMetadataChange(change),
    });
    this.broadcast = new Broadcast(config, this.metadata, {
      sessionCount: () => this.sessions.size,
      notify: (content) => this.messages.sendToAll(this.sessions.values(), content),
      onPlaying: () => {
        for (const session of this.sessions.values()) this.messages.scheduleUpdate(session);
      },
      onRetriesExhausted: async () => {
        await Promise.all(
          [...this.sessions.values()].map((session) =>
            this.sessions.stop(session, "retries_exhausted"),
          ),
        );
      },
    });
    this.messages = new NowPlayingMessages(client, this.metadata, {
      station: () => ({ name: this.broadcast.stationName, websiteUrl: config.websiteUrl }),
      statusOf: (session) => this.effectiveStatus(session),
      listenerCount: (session) => this.sessions.listenerCount(session),
    });
    this.sessions = new VoiceSessions(client, config, this.broadcast, this.messages, () =>
      this.syncPresence(),
    );
  }

  public recordCommand(command: string): void {
    this.commandCounts.set(command, (this.commandCounts.get(command) ?? 0) + 1);
  }

  public getMetrics(): RadioMetrics {
    const statuses = [...this.sessions.values()].map((session) => this.effectiveStatus(session));
    return {
      sessions: statuses.length,
      playingSessions: statuses.filter((status) => status === "playing").length,
      reconnectingSessions: statuses.filter((status) => status === "reconnecting").length,
      streamFailures: this.broadcast.failures,
      totalRetries: this.sessions.totalRetries + this.broadcast.totalRetries,
      metadataUpdates: this.metadata.updates,
      commands: Object.fromEntries(this.commandCounts),
    };
  }

  public async play(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.defer(interaction))) return;
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply("Este comando solo funciona dentro de un servidor.");
      return;
    }

    const member = await this.resolveMember(interaction);
    const voiceChannel = member?.voice.channel;
    if (!member || !voiceChannel) {
      await interaction.editReply("Primero entra a un canal de voz y luego usa `/play`.");
      return;
    }
    if (voiceChannel.type === ChannelType.GuildStageVoice) {
      await interaction.editReply(
        "Los canales Stage no estan habilitados: usa un canal de voz normal.",
      );
      return;
    }
    if (voiceChannel.type !== ChannelType.GuildVoice) {
      await interaction.editReply("Ese canal no es compatible con la radio.");
      return;
    }

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const permissions = me ? voiceChannel.permissionsFor(me) : null;
    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.Connect) ||
      !permissions.has(PermissionFlagsBits.Speak)
    ) {
      await interaction.editReply(
        "Necesito permisos para **Ver**, **Conectar** y **Hablar** en ese canal.",
      );
      return;
    }

    let existing = this.sessions.get(guild.id);
    if (existing?.stopping && existing.stopPromise) {
      await existing.stopPromise;
      existing = this.sessions.get(guild.id);
    }
    if (existing && !existing.stopping) {
      if (existing.voiceChannelId === voiceChannel.id) {
        existing.textChannelId = interaction.channelId;
        const status = this.effectiveStatus(existing);
        await interaction.editReply(
          status === "playing"
            ? `Ya estoy reproduciendo en **${voiceChannel.name}**.`
            : `La sesion de **${voiceChannel.name}** esta ${statusLabel(status).toLowerCase()}.`,
        );
        await this.messages.publish(existing, true);
        this.sessions.requestIdleRefresh(existing);
        return;
      }

      const listenerCount = await this.sessions.listenerCount(existing);
      const canMove = member.permissions.has(PermissionFlagsBits.MoveMembers);
      if (listenerCount > 0 && !canMove) {
        await interaction.editReply(
          `Ya estoy reproduciendo en <#${existing.voiceChannelId}>. ` +
            "Necesitas **Mover miembros** para trasladarme mientras haya oyentes.",
        );
        return;
      }

      await this.sessions.stop(existing, "replaced");
    }

    await interaction.editReply(`Conectando a **${voiceChannel.name}**...`);
    const session = this.sessions.create({
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      adapterCreator: guild.voiceAdapterCreator,
    });

    try {
      await this.sessions.start(session);
      if (this.sessions.get(guild.id) !== session || session.status !== "playing") {
        throw new Error("La sesion termino antes de iniciar la reproduccion");
      }
      await interaction.editReply(
        `Reproduciendo **${this.broadcast.stationName}** en **${voiceChannel.name}**.`,
      );
      await this.messages.publish(session, true);
      this.sessions.requestIdleRefresh(session);
    } catch (error) {
      logger.error("play.failed", { ...sessionContext(session), error: errorMessage(error) });
      await interaction
        .editReply(`No pude iniciar la radio: ${errorMessage(error)}`)
        .catch(() => null);
      if (this.sessions.get(guild.id) === session)
        await this.sessions.stop(session, "start_failed");
    }
  }

  public async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "Este comando solo funciona en un servidor.",
        ephemeral: true,
      });
      return;
    }
    const session = this.sessions.get(guild.id);
    if (!session || session.stopping) {
      await interaction.reply({
        content: "No hay una radio activa en este servidor.",
        ephemeral: true,
      });
      return;
    }
    const member = await this.resolveMember(interaction);
    const sameChannel = member?.voice.channelId === session.voiceChannelId;
    const canMove = member?.permissions.has(PermissionFlagsBits.MoveMembers) ?? false;
    if (!sameChannel && !canMove) {
      await interaction.reply({
        content: "Debes estar en mi canal de voz o tener **Mover miembros** para detenerme.",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply();
    await this.sessions.stop(session, "command");
    await interaction.editReply("Radio detenida. Hasta pronto.");
  }

  public async nowPlaying(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = interaction.guildId ? this.sessions.get(interaction.guildId) : undefined;
    if (!session || session.stopping) {
      await interaction.reply({
        content: "No hay una radio activa en este servidor.",
        ephemeral: true,
      });
      return;
    }
    if (!(await this.defer(interaction))) return;
    await interaction.editReply(await this.messages.build(session));
  }

  public async status(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = interaction.guildId ? this.sessions.get(interaction.guildId) : undefined;
    if (!session || session.stopping) {
      await interaction.reply({
        content: "No hay una radio activa en este servidor.",
        ephemeral: true,
      });
      return;
    }
    const listeners = await this.sessions.listenerCount(session);
    const embed = buildStatusEmbed({
      stationName: this.broadcast.stationName,
      status: this.effectiveStatus(session),
      voiceChannelId: session.voiceChannelId,
      listeners,
      uptimeMs: Date.now() - session.createdAt,
      ping: session.connection.ping,
      voiceRetries: session.totalRetries,
      streamRetries: this.broadcast.retries,
      metadataSource: this.metadata.source,
      lastAudioAt: this.broadcast.lastAudioAt,
      lastError: session.lastError ?? this.broadcast.lastError,
    });
    await interaction.reply({ embeds: [embed] });
  }

  public onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    this.sessions.handleVoiceStateUpdate(oldState, newState);
  }

  public async shutdown(): Promise<void> {
    this.presence.dispose();
    await Promise.all(
      [...this.sessions.values()].map((session) => this.sessions.stop(session, "shutdown")),
    );
    this.broadcast.stop();
  }

  private async defer(interaction: ChatInputCommandInteraction): Promise<boolean> {
    try {
      await interaction.deferReply();
      return true;
    } catch (error) {
      logger.warn("interaction.defer_failed", {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        error: errorMessage(error),
      });
      return false;
    }
  }

  private async resolveMember(
    interaction: ChatInputCommandInteraction,
  ): Promise<GuildMember | null> {
    if (!interaction.guild) return null;
    if (interaction.member instanceof GuildMember) return interaction.member;
    return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  }

  private onMetadataChange({ source, title, artworkChanged }: MetadataChange): void {
    logger.info("metadata.updated", {
      source,
      title,
      hasArtwork: Boolean(this.metadata.artworkUrl),
      sessions: this.sessions.size,
    });
    if (this.sessions.size > 0) {
      this.presence.schedule(title);
      // La portada empieza a bajar ya, en paralelo con la espera de la edicion.
      if (artworkChanged) void this.metadata.cover(true);
    }
    for (const session of this.sessions.values()) this.messages.scheduleUpdate(session);
  }

  private syncPresence(): void {
    const active = [...this.sessions.values()].some((session) => !session.stopping);
    this.presence.sync(active ? this.metadata.title : null);
  }

  private effectiveStatus(session: GuildSession): SessionStatus {
    return effectiveStatus(session, this.broadcast.status);
  }
}
