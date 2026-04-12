#!/usr/bin/env node
import { render } from 'ink';
import React from 'react';
import { parseArgs } from 'node:util';
import { App } from '../src/index.js';
import { WORDMARK } from '../src/lib/colors.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model:        { type: 'string',  short: 'm' },
    provider:     { type: 'string',  short: 'p' },
    conversation: { type: 'string',  short: 'c' },
    help:         { type: 'boolean', short: 'h' },
    version:      { type: 'boolean', short: 'v' },
  },
  allowPositionals: true,
});

if (values.version) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const pkg = require('../package.json') as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

if (values.help) {
  console.log(`
${WORDMARK}  —  terminal LLM developer assistant

USAGE
  uplnk [command] [options]

COMMANDS
  chat            Start or resume a conversation (default)
  doctor          Run preflight checks
  config          Open config in $EDITOR
  conversations   List saved conversations

OPTIONS
  -m, --model         Model name (e.g. llama3.2, qwen2.5-coder:7b)
  -p, --provider      Provider ID from config
  -c, --conversation  Resume conversation by ID
  -h, --help          Show this help
  -v, --version       Show version
  `);
  process.exit(0);
}

const [subcommand] = positionals;

if (subcommand === 'doctor') {
  const { runDoctor } = await import('../src/lib/doctor.js');
  await runDoctor();
  process.exit(0);
}

const { waitUntilExit } = render(
  React.createElement(App, {
    ...(values.model !== undefined ? { initialModel: values.model } : {}),
    ...(values.provider !== undefined ? { initialProvider: values.provider } : {}),
    ...(values.conversation !== undefined ? { resumeConversationId: values.conversation } : {}),
    subcommand: subcommand ?? 'chat',
  }),
  { exitOnCtrlC: false },
);

await waitUntilExit();
