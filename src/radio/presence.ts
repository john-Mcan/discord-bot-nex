// Actividad del bot en Discord: "Escuchando <cancion>" mientras suena la radio
// y una invitacion a usar /play cuando no hay sesiones.
import { ActivityType, type Client } from "discord.js";

// Discord limita los cambios de presencia: como maximo uno cada 10 s.
const PRESENCE_UPDATE_INTERVAL_MS = 10_000;

export class Presence {
  private pendingTitle: string | null = null;
  private publishedTitle: string | null = null;
  private lastUpdateAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly client: Client) {}

  public schedule(title: string): void {
    this.pendingTitle = title;
    const remaining = PRESENCE_UPDATE_INTERVAL_MS - (Date.now() - this.lastUpdateAt);
    if (remaining <= 0) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, remaining);
    }
  }

  // Con un titulo lo muestra como cancion; sin titulo vuelve al estado inicial.
  public sync(title: string | null): void {
    if (title) {
      this.schedule(title);
      return;
    }
    this.pendingTitle = null;
    this.publishedTitle = null;
    this.client.user?.setPresence({
      activities: [{ name: "dale /play a NEX!", type: ActivityType.Playing }],
      status: "online",
    });
  }

  public dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private flush(): void {
    const title = this.pendingTitle?.trim();
    if (!title || title === this.publishedTitle) return;
    this.pendingTitle = null;
    this.publishedTitle = title;
    this.lastUpdateAt = Date.now();
    this.client.user?.setPresence({
      activities: [{ name: title.slice(0, 128), type: ActivityType.Listening }],
      status: "online",
    });
  }
}
