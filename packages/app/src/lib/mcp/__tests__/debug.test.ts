import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const transportInstances: any[] = [];
let connectImpl: () => Promise<void> = () => Promise.resolve();
let listToolsImpl: () => Promise<any> = () => Promise.resolve({ tools: [] });
const mockConnect = vi.fn(() => connectImpl());
const mockClose = vi.fn(() => Promise.resolve());
const mockListTools = vi.fn(() => listToolsImpl());
const mockCallTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({ connect: mockConnect, close: mockClose, listTools: mockListTools, callTool: mockCallTool })),
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation((opts: unknown) => {
    const t: any = { onclose: undefined, onerror: undefined, _opts: opts };
    transportInstances.push(t);
    return t;
  }),
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(() => { throw new Error('ENOENT'); }), realpathSync: (p: string) => p, mkdirSync: vi.fn(), appendFileSync: vi.fn(), existsSync: vi.fn(() => false), renameSync: vi.fn(), unlinkSync: vi.fn() };
});

import { McpManager, BUILTIN_FILE_BROWSE_ID, type McpServerConfig } from '../McpManager.js';
import { createDefaultPolicy } from '../security.js';

const BUILTIN_CFG: McpServerConfig = { id: BUILTIN_FILE_BROWSE_ID, name: 'b', command: '/x', args: [] };

describe('debug', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    transportInstances.length = 0;
    connectImpl = () => Promise.resolve();
    mockConnect.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('traces', async () => {
    const mgr = new McpManager({ filePolicy: createDefaultPolicy(['/p']), commandExecEnabled: false, gitEnabled: false, ragEnabled: false, requestApproval: vi.fn().mockResolvedValue(true) });
    await mgr.connect(BUILTIN_CFG);
    console.log('after initial connect, state:', (mgr as any).reconnectState.get(BUILTIN_FILE_BROWSE_ID));
    transportInstances[0]!.onclose!();
    console.log('after onclose, state:', (mgr as any).reconnectState.get(BUILTIN_FILE_BROWSE_ID));

    let cycle = 0;
    const origConnect = connectImpl;
    connectImpl = () => origConnect().then(() => {
      cycle++;
      console.log('connectImpl cycle=', cycle);
      if (cycle <= 2) {
        queueMicrotask(() => {
          console.log('queueMicrotask fires onclose, current state:', (mgr as any).reconnectState.get(BUILTIN_FILE_BROWSE_ID));
          const fresh = transportInstances[transportInstances.length - 1]!;
          fresh.onclose?.();
          console.log('after fresh.onclose, state:', (mgr as any).reconnectState.get(BUILTIN_FILE_BROWSE_ID));
        });
      }
    });

    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    console.log('after first retry, state:', (mgr as any).reconnectState.get(BUILTIN_FILE_BROWSE_ID), 'mockConnect calls:', mockConnect.mock.calls.length);

    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    console.log('after second advance, state:', (mgr as any).reconnectState.get(BUILTIN_FILE_BROWSE_ID), 'mockConnect calls:', mockConnect.mock.calls.length);
    expect(mockConnect).toHaveBeenCalledTimes(3);
  });
});
