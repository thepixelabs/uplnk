import { vi } from 'vitest';
import type { Transport, TransportKind } from '../../robotic/transport/Transport.js';

export type MockTransport = Transport & {
  mockWrite: ReturnType<typeof vi.fn>;
  mockRead: ReturnType<typeof vi.fn>;
  mockClose: ReturnType<typeof vi.fn>;
  mockStart: ReturnType<typeof vi.fn>;
};

export function createMockTransport(kind: TransportKind = 'pipe'): MockTransport {
  const mockStart = vi.fn().mockResolvedValue(undefined);
  const mockWrite = vi.fn().mockResolvedValue(undefined);
  const mockRead = vi.fn().mockResolvedValue('');
  const mockClose = vi.fn().mockResolvedValue(undefined);
  let ready = false;

  const transport: MockTransport = {
    kind,
    async start() { await mockStart(); ready = true; },
    async write(text: string) { return mockWrite(text) as Promise<void>; },
    async readUntilIdle(opts: { timeoutMs: number; idleMs: number }) {
      return mockRead(opts) as Promise<string>;
    },
    async *events() { /* no events by default */ },
    async close() { return mockClose() as Promise<void>; },
    isReady() { return ready; },
    mockWrite,
    mockRead,
    mockClose,
    mockStart,
  };

  return transport;
}
