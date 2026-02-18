import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:net';
import { findFreePort, waitForPort } from '../../src/utils/port.js';

describe('findFreePort', () => {
  it('returns a valid port number', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it('returns different ports on successive calls', async () => {
    const port1 = await findFreePort();
    const port2 = await findFreePort();
    expect(port1).not.toBe(port2);
  });
});

describe('waitForPort', () => {
  it('resolves when a server is listening', async () => {
    const port = await findFreePort();

    // Start a server on the port
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    try {
      // Should resolve quickly since server is already listening
      await waitForPort(port, { timeoutMs: 5000 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects on timeout when nothing is listening', async () => {
    const port = await findFreePort();
    // No server — should timeout
    await expect(
      waitForPort(port, { timeoutMs: 500, intervalMs: 100 }),
    ).rejects.toThrow(/not reachable/);
  });
});
