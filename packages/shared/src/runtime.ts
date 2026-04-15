export type UplnkRuntime = 'tui' | 'headless' | 'robotic';

export interface TmuxContext {
  inside: boolean;
  socket?: string;
  pane?: string;
}

export interface RuntimeContext {
  mode: UplnkRuntime;
  isTTY: boolean;
  tmux: TmuxContext;
}

export function detectRuntime(): RuntimeContext {
  const isTTY = Boolean(process.stdout.isTTY);
  const tmuxEnv = process.env['TMUX'];
  const insideTmux = Boolean(tmuxEnv);
  const socketValue = tmuxEnv !== undefined ? (tmuxEnv.split(',')[0] ?? tmuxEnv) : undefined;
  const tmux: TmuxContext = socketValue !== undefined
    ? { inside: insideTmux, socket: socketValue }
    : { inside: insideTmux };
  return {
    mode: 'tui',
    isTTY,
    tmux,
  };
}
