import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TmpFlowDir {
  dir: string;
  writeFlow(filename: string, content: string): string;
  writeYaml(name: string, yaml: string): string;
  writeJson(name: string, obj: object): string;
  cleanup(): void;
}

/**
 * Creates a temporary directory for flow files.
 * Call cleanup() in afterEach.
 */
export function createTmpFlowDir(): TmpFlowDir {
  const dir = mkdtempSync(join(tmpdir(), 'uplnk-flows-'));

  return {
    dir,
    writeFlow(filename: string, content: string): string {
      const filePath = join(dir, filename);
      writeFileSync(filePath, content, 'utf-8');
      return filePath;
    },
    writeYaml(name: string, yaml: string): string {
      const filename = `${name}.yaml`;
      const filePath = join(dir, filename);
      writeFileSync(filePath, yaml, 'utf-8');
      return filePath;
    },
    writeJson(name: string, obj: object): string {
      const filename = `${name}.json`;
      const filePath = join(dir, filename);
      writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
      return filePath;
    },
    cleanup(): void {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** A minimal valid flow YAML string */
export const MINIMAL_VALID_FLOW_YAML = `apiVersion: uplnk.io/v1
name: test-flow
steps:
  - id: step1
    type: chat
    prompt: "Hello world"
`;

/** A minimal valid flow object (for JSON flows) */
export const MINIMAL_VALID_FLOW_OBJ = {
  apiVersion: 'uplnk.io/v1' as const,
  name: 'test-flow',
  steps: [{ id: 'step1', type: 'chat' as const, prompt: 'Hello world' }],
};
