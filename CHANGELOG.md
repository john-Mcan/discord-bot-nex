# Cambios

Los cambios relevantes de cada versión. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones usan
[SemVer](https://semver.org/lang/es/).

## [Sin publicar]

## [0.2.0] - 2026-10-31

### Agregado

- Imagen Docker multietapa sobre `node:22-slim`, con usuario sin privilegios y healthcheck contra
  `/healthz`, y un `compose.yaml` de ejemplo.
- CI en GitHub Actions (lint, formato, tipos, tests y build) y Dependabot mensual para npm y
  GitHub Actions.
- ESLint con typescript-eslint, Prettier y los scripts `lint`, `format`, `typecheck` y `check`.
- Tests de la extracción de metadata, la próxima consulta y la cuenta regresiva, el backoff, las
  variables de entorno, los mensajes y las sesiones de voz, y una prueba de integración que
  transmite por FFmpeg real y se recupera de un corte del stream.
- Licencia MIT.

### Cambiado

- Mensaje «sonando ahora» rediseñado con la identidad de NEX: título enlazado, artista, cuenta
  regresiva, oyentes, votación y botón «Escuchar en…».
- `RadioManager` se divide en módulos con una responsabilidad cada uno (transmisión, sesiones de
  voz, metadata, mensajes, vista, presencia, portadas, ICY y backoff), sin cambios de
  comportamiento ni de su API.
- La validación de variables de entorno pasa a una función pura (`parseEnv`).
- El logo se mueve de `img/` a `assets/`.
- README reescrito, con capturas, arquitectura, operación y despliegue.

### Corregido

- La metadata se consulta justo al empezar la canción nueva (fin + 1,3 s) y la cuenta regresiva
  termina cuando cambia el audio (fin + 1 s), sin llegar a mostrar «hace X segundos».

## [0.1.0] - 2026-10-08

Corresponde al tag `estable-2026-10-08`.

### Agregado

- Comandos `/play`, `/stop`, `/nowplaying` y `/status`, con los alias `/radio` y `/leave` y
  cooldown por usuario.
- Un solo stream HTTP y un solo FFmpeg compartidos por todos los servidores.
- Metadata desde el snapshot del backend NEX, AzuraCast (con descubrimiento del endpoint), un JSON
  con rutas configurables o los títulos ICY del stream.
- Mensaje persistente con la portada adjunta y el logo de la radio como respaldo.
- Reconexión con backoff exponencial, desconexión por inactividad y protección contra traslados.
- Logs JSON, `/healthz` y métricas de Prometheus.

[Sin publicar]: https://github.com/john-Mcan/discord-bot-nex/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/john-Mcan/discord-bot-nex/compare/estable-2026-10-08...v0.2.0
[0.1.0]: https://github.com/john-Mcan/discord-bot-nex/tree/estable-2026-10-08
