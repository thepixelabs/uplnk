/**
 * useTerminalSize — returns current terminal dimensions and re-renders on resize.
 *
 * Ink exposes terminal size via process.stdout.columns / process.stdout.rows.
 * We listen to the 'resize' event on process.stdout to update state.
 */

import { useState, useEffect } from 'react';

export interface TerminalSize {
  columns: number;
  rows: number;
}

function getSize(): TerminalSize {
  return {
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(getSize);

  useEffect(() => {
    const handler = () => setSize(getSize());
    process.stdout.on('resize', handler);
    return () => {
      process.stdout.off('resize', handler);
    };
  }, []);

  return size;
}
