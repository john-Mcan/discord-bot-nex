import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

// Ejecuta src/healthcheck.ts como lo haria Docker y devuelve su codigo de salida.
async function runHealthcheck(port: string): Promise<number | null> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/healthcheck.ts"], {
    env: { ...process.env, HEALTH_PORT: port },
    stdio: "ignore",
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return code;
}

test("el healthcheck de Docker sigue la respuesta de /healthz", async () => {
  let status = 200;
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? status : 404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = String((server.address() as AddressInfo).port);
  try {
    assert.equal(await runHealthcheck(port), 0);
    status = 503;
    assert.equal(await runHealthcheck(port), 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Sin servidor escuchando falla; con HEALTH_PORT=0 el healthcheck esta desactivado.
  assert.equal(await runHealthcheck(port), 1);
  assert.equal(await runHealthcheck("0"), 0);
});
