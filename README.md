# Bot Radio DS

Bot de Discord para reproducir una radio online en canales de voz. Está construido con TypeScript, `discord.js`, `@discordjs/voice` y FFmpeg.

## Funciones

- Reproducción de streams MP3/AAC por HTTP o HTTPS.
- Metadata ICY y fallback mediante endpoint JSON.
- Un solo stream y un solo FFmpeg compartidos por todos los servidores: escala sin multiplicar conexiones a la radio.
- Metadata consultada una vez para todos los servidores, justo al terminar cada canción.
- Portada adjunta al mensaje, con el ícono de la radio como respaldo.
- Mensaje persistente y comando para la canción actual.
- Reconexión serializada con backoff exponencial.
- Desconexión automática cuando el canal queda vacío.
- Protección para que otros usuarios no trasladen una sesión con oyentes.
- Cooldown de comandos.
- Logs JSON estructurados.
- Healthcheck JSON y métricas Prometheus.

## Requisitos

- Node.js 22.12 o superior.
- Token de un bot de Discord.
- Permisos `View Channel`, `Connect` y `Speak` en el canal de voz.

FFmpeg se instala mediante `ffmpeg-static`; no se necesita una instalación global.

## Instalación

```bash
npm install
copy .env.example .env
npm run deploy:commands
npm run build
npm start
```

Si `DEV_GUILD_ID` está configurado, `deploy:commands` registra los comandos solo en ese servidor y aparecen inmediatamente. Sin esa variable se registran globalmente.

## Variables de entorno

| Variable | Uso | Valor predeterminado |
|---|---|---|
| `DISCORD_TOKEN` | Token del bot | Obligatoria |
| `DISCORD_CLIENT_ID` | ID de la aplicación | Obligatoria |
| `RADIO_STREAM_URL` | Stream HTTP/HTTPS | Obligatoria |
| `DEV_GUILD_ID` | Registro rápido de comandos en desarrollo | Global |
| `RADIO_NAME` | Nombre mostrado en embeds | `Radio` |
| `IDLE_DISCONNECT_MINUTES` | Tiempo con cero oyentes | `5` |
| `COMMAND_COOLDOWN_SECONDS` | Cooldown por usuario y comando | `3` |
| `RADIO_METADATA_URL` | Endpoint JSON de metadata (NEX: `https://api.nex-radio.com/api/radio/snapshot`) | API de AzuraCast inferida del stream |
| `RADIO_METADATA_TITLE_PATH` | Ruta por puntos al título | Autodetección |
| `RADIO_METADATA_ARTIST_PATH` | Ruta por puntos al artista | Autodetección |
| `RADIO_METADATA_ARTWORK_PATH` | Ruta por puntos a la portada | Autodetección |
| `METADATA_POLL_SECONDS` | Intervalo del endpoint JSON | `15` |
| `HEALTH_HOST` | Interfaz del healthcheck | `127.0.0.1` |
| `HEALTH_PORT` | Puerto; `0` lo deshabilita | `3000` |

El extractor JSON reconoce automáticamente formatos comunes, incluido AzuraCast (`now_playing.song.title`, `now_playing.song.artist` y `now_playing.song.art`) y el snapshot del backend NEX (`now_playing.song.cover_url`, servido desde el CDN de Cloudflare). Se recomienda usar el backend NEX para no cargar a AzuraCast con las consultas del bot. Para streams AzuraCast con ruta `/listen/<estación>/...`, el bot descubre automáticamente el endpoint `/api/nowplaying/<estación>`. Los paths configurables permiten usar otros proveedores sin cambiar código.

## Comandos

| Comando | Descripción |
|---|---|
| `/play`, `/radio` | Conecta el bot y reproduce la radio |
| `/stop`, `/leave` | Detiene y desconecta el bot |
| `/nowplaying` | Muestra la canción y sesión actuales |
| `/status` | Muestra canal, oyentes, uptime, ping y reintentos |

Un usuario no puede mover el bot a otro canal mientras haya oyentes, salvo que tenga el permiso `Move Members`. Los canales Stage se rechazan explícitamente; se requiere un canal de voz normal.

## Operación

- `GET /healthz`: estado JSON del cliente y las sesiones.
- `GET /metrics`: métricas en formato Prometheus.
- Los logs se escriben como un objeto JSON por línea e incluyen `sessionId`, `guildId` y `voiceChannelId` cuando corresponde.

## Desarrollo

```bash
npm run dev
npm test
npm run build
npm audit
```

## Licencia

© 2026. Todos los derechos reservados. Proyecto proporcionado con fines educativos y de aprendizaje.
