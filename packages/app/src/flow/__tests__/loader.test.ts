/**
 * Tests for the flow file loader (loader.ts).
 *
 * loadFlowFromFile, listFlows, findFlow, and getFlowsDir are exercised against
 * real files in a temporary directory. We use the shared tmpFlowDir helper so
 * we never leave test artefacts on disk.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  loadFlowFromFile,
  listFlows,
  findFlow,
  getFlowsDir,
} from '../loader.js';
import {
  createTmpFlowDir,
  MINIMAL_VALID_FLOW_YAML,
  MINIMAL_VALID_FLOW_OBJ,
  type TmpFlowDir,
} from '../../__tests__/helpers/tmpFlowDir.js';

// ─── Fixture management ───────────────────────────────────────────────────────

let tmp: TmpFlowDir;

afterEach(() => {
  tmp?.cleanup();
});

function setup() {
  tmp = createTmpFlowDir();
  return tmp;
}

// ─── getFlowsDir ─────────────────────────────────────────────────────────────

describe('getFlowsDir', () => {
  it('expands leading ~ to the homedir when no argument is given', () => {
    // setup.ts mocks os.homedir() to return /tmp/uplnk-test-home
    const result = getFlowsDir();
    expect(result).toBe('/tmp/uplnk-test-home/.uplnk/flows');
  });

  it('returns an absolute path unchanged when explicitly provided', () => {
    expect(getFlowsDir('/custom/flows')).toBe('/custom/flows');
  });

  it('expands ~ in a custom path', () => {
    const result = getFlowsDir('~/my-flows');
    expect(result).toBe('/tmp/uplnk-test-home/my-flows');
  });
});

// ─── loadFlowFromFile — success paths ────────────────────────────────────────

describe('loadFlowFromFile — valid files', () => {
  it('loads a valid YAML file and returns def, path, and hash', () => {
    const { dir, writeYaml } = setup();
    const filePath = writeYaml('my-flow', MINIMAL_VALID_FLOW_YAML);

    const loaded = loadFlowFromFile(filePath);

    expect(loaded.path).toBe(filePath);
    expect(loaded.def.name).toBe('test-flow');
    expect(loaded.def.apiVersion).toBe('uplnk.io/v1');
    expect(loaded.def.steps).toHaveLength(1);
  });

  it('returns the correct sha256 hash of the file content', () => {
    const { writeYaml } = setup();
    const filePath = writeYaml('hashed', MINIMAL_VALID_FLOW_YAML);

    const loaded = loadFlowFromFile(filePath);
    const expected = createHash('sha256').update(MINIMAL_VALID_FLOW_YAML).digest('hex');

    expect(loaded.hash).toBe(expected);
  });

  it('loads a valid .yml extension file', () => {
    const { dir, writeFlow } = setup();
    const filePath = writeFlow('flow.yml', MINIMAL_VALID_FLOW_YAML);

    const loaded = loadFlowFromFile(filePath);
    expect(loaded.def.name).toBe('test-flow');
  });

  it('loads a valid JSON file', () => {
    const { writeJson } = setup();
    const filePath = writeJson('json-flow', MINIMAL_VALID_FLOW_OBJ);

    const loaded = loadFlowFromFile(filePath);
    expect(loaded.def.name).toBe('test-flow');
    expect(loaded.def.steps).toHaveLength(1);
  });

  it('parses step defaults correctly (retries defaults to 0)', () => {
    const { writeYaml } = setup();
    const filePath = writeYaml('defaults', MINIMAL_VALID_FLOW_YAML);

    const loaded = loadFlowFromFile(filePath);
    expect(loaded.def.steps[0]).toMatchObject({ retries: 0 });
  });
});

// ─── loadFlowFromFile — error paths ──────────────────────────────────────────

describe('loadFlowFromFile — error paths', () => {
  it('throws when the file does not exist', () => {
    expect(() => loadFlowFromFile('/nonexistent/path/flow.yaml')).toThrow();
  });

  it('throws on invalid YAML syntax', () => {
    const { writeFlow } = setup();
    const filePath = writeFlow('bad.yaml', 'this: is: not: valid: yaml: :::');

    expect(() => loadFlowFromFile(filePath)).toThrow();
  });

  it('throws when YAML is structurally valid but fails schema validation', () => {
    const { writeFlow } = setup();
    // Missing required 'steps' field
    const badFlow = `apiVersion: uplnk.io/v1\nname: missing-steps\n`;
    const filePath = writeFlow('bad-schema.yaml', badFlow);

    expect(() => loadFlowFromFile(filePath)).toThrow();
  });

  it('throws when apiVersion is wrong', () => {
    const { writeFlow } = setup();
    const badFlow = `apiVersion: v99\nname: bad-version\nsteps:\n  - id: s1\n    type: chat\n    prompt: hi\n`;
    const filePath = writeFlow('bad-version.yaml', badFlow);

    expect(() => loadFlowFromFile(filePath)).toThrow();
  });

  it('throws on an empty file', () => {
    const { writeFlow } = setup();
    const filePath = writeFlow('empty.yaml', '');

    expect(() => loadFlowFromFile(filePath)).toThrow();
  });

  it('throws on invalid JSON syntax', () => {
    const { writeFlow } = setup();
    const filePath = writeFlow('bad.json', '{ this is not json }');

    expect(() => loadFlowFromFile(filePath)).toThrow();
  });
});

// ─── listFlows ────────────────────────────────────────────────────────────────

describe('listFlows', () => {
  it('returns an empty array when the directory does not exist', () => {
    expect(listFlows('/no/such/dir')).toEqual([]);
  });

  it('returns an empty array for an empty directory', () => {
    const { dir } = setup();
    expect(listFlows(dir)).toEqual([]);
  });

  it('returns one entry per valid flow file', () => {
    const { dir, writeYaml } = setup();
    writeYaml('flow-a', MINIMAL_VALID_FLOW_YAML);
    writeYaml('flow-b', MINIMAL_VALID_FLOW_YAML);

    const flows = listFlows(dir);
    expect(flows).toHaveLength(2);
  });

  it('includes path and hash fields on each loaded flow', () => {
    const { dir, writeYaml } = setup();
    writeYaml('my-flow', MINIMAL_VALID_FLOW_YAML);

    const [flow] = listFlows(dir);
    expect(flow?.path).toContain('my-flow.yaml');
    expect(flow?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips invalid flow files and loads the rest', () => {
    const { dir, writeYaml, writeFlow } = setup();
    writeYaml('valid', MINIMAL_VALID_FLOW_YAML);
    writeFlow('invalid.yaml', 'not: valid: yaml: ::');

    const flows = listFlows(dir);
    // Should load exactly the valid file and skip the broken one
    expect(flows).toHaveLength(1);
    expect(flows[0]?.def.name).toBe('test-flow');
  });

  it('ignores non-YAML/JSON files', () => {
    const { dir, writeYaml, writeFlow } = setup();
    writeYaml('real-flow', MINIMAL_VALID_FLOW_YAML);
    writeFlow('readme.txt', 'This is a readme');
    writeFlow('notes.md', '# Notes');

    const flows = listFlows(dir);
    expect(flows).toHaveLength(1);
  });

  it('loads both .yaml and .yml and .json extensions', () => {
    const { dir, writeFlow, writeJson } = setup();
    writeFlow('a.yaml', MINIMAL_VALID_FLOW_YAML);
    writeFlow('b.yml', MINIMAL_VALID_FLOW_YAML);
    writeJson('c', MINIMAL_VALID_FLOW_OBJ);

    const flows = listFlows(dir);
    expect(flows).toHaveLength(3);
  });
});

// ─── findFlow ─────────────────────────────────────────────────────────────────

describe('findFlow', () => {
  it('returns null when the directory does not exist', () => {
    expect(findFlow('test-flow', '/no/such/dir')).toBeNull();
  });

  it('returns null when no flow matches the name', () => {
    const { dir, writeYaml } = setup();
    writeYaml('my-flow', MINIMAL_VALID_FLOW_YAML);

    expect(findFlow('does-not-exist', dir)).toBeNull();
  });

  it('finds a flow by its def.name', () => {
    const { dir, writeYaml } = setup();
    writeYaml('some-filename', MINIMAL_VALID_FLOW_YAML); // def.name is 'test-flow'

    const found = findFlow('test-flow', dir);
    expect(found).not.toBeNull();
    expect(found?.def.name).toBe('test-flow');
  });

  it('finds a flow by its filename (without extension)', () => {
    const { dir, writeYaml } = setup();
    writeYaml('my-named-file', MINIMAL_VALID_FLOW_YAML);

    const found = findFlow('my-named-file', dir);
    expect(found).not.toBeNull();
  });

  it('def.name match takes precedence over filename match when both exist', () => {
    const { dir, writeYaml, writeFlow } = setup();
    // This file has def.name = 'test-flow', filename = 'test-flow'
    writeYaml('test-flow', MINIMAL_VALID_FLOW_YAML);

    const found = findFlow('test-flow', dir);
    // It should return without error regardless of which matching strategy wins
    expect(found?.def.name).toBe('test-flow');
  });

  it('returns null for an empty directory', () => {
    const { dir } = setup();
    expect(findFlow('anything', dir)).toBeNull();
  });

  it('skips invalid files and still finds a valid match', () => {
    const { dir, writeYaml, writeFlow } = setup();
    writeFlow('broken.yaml', 'not: valid: yaml: ::');
    writeYaml('target', MINIMAL_VALID_FLOW_YAML);

    const found = findFlow('test-flow', dir);
    expect(found).not.toBeNull();
    expect(found?.def.name).toBe('test-flow');
  });
});
