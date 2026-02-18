import { createServer, type Server } from 'node:net';
import { Socket } from 'node:net';

/**
 * Find a free port by letting the OS assign one (listen on port 0).
 * Returns the assigned port number after closing the server.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to get port from server address'));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export interface WaitForPortOptions {
  host?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Wait until a TCP port is accepting connections.
 * Polls by attempting to connect via a raw socket.
 */
export async function waitForPort(
  port: number,
  opts?: WaitForPortOptions,
): Promise<void> {
  const host = opts?.host ?? '127.0.0.1';
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 200;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await tryConnect(port, host);
    if (connected) return;
    await sleep(intervalMs);
  }

  throw new Error(`Port ${port} on ${host} not reachable after ${timeoutMs}ms`);
}

function tryConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
