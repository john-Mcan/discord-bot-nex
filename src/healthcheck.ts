// Healthcheck del contenedor: consulta /healthz dentro del mismo contenedor.
// Sale con 0 si el bot responde (o si el healthcheck esta desactivado con
// HEALTH_PORT=0) y con 1 en cualquier otro caso.
const port = process.env.HEALTH_PORT || "3000";

if (port === "0") {
  process.exit(0);
}

fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4_000) })
  .then((response) => process.exit(response.ok ? 0 : 1))
  .catch(() => process.exit(1));
