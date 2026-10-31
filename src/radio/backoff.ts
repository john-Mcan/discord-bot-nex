// Backoff exponencial con variacion aleatoria para los reintentos de conexion
// (voz y stream): 1,5 s, 3 s, 6 s, 12 s y 24 s, mas hasta 0,75 s al azar para
// que los reintentos de varios servidores no coincidan.
export const MAX_START_ATTEMPTS = 5;

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const delayMs = Math.min(30_000, 1_500 * 2 ** Math.min(attempt - 1, 4));
  return delayMs + Math.floor(random() * 750);
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
