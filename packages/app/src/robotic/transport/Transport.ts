export type TransportKind = 'tmux' | 'pty' | 'pipe';

export interface TransportEvent {
  type: 'ready' | 'data' | 'exit' | 'error';
  data?: string;
  exitCode?: number;
  error?: string;
}

export interface Transport {
  readonly kind: TransportKind;

  /** Start the transport (spawn process, connect to tmux pane, etc.) */
  start(): Promise<void>;

  /** Write text to the target terminal (inject a message) */
  write(text: string): Promise<void>;

  /**
   * Read output until it goes idle (no new output for idleMs).
   * Returns empty string on timeout.
   */
  readUntilIdle(opts: { timeoutMs: number; idleMs: number }): Promise<string>;

  /** Async iterable of transport lifecycle events */
  events(): AsyncIterable<TransportEvent>;

  /** Clean up resources */
  close(): Promise<void>;

  /** Returns true when the transport is ready to receive writes */
  isReady(): boolean;
}
