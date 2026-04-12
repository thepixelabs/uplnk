# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in uplnk, please report it privately by emailing **pixi@pixelabs.net** with the subject line `[uplnk] Security Vulnerability`.

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- The version of uplnk you are using
- Your OS and Node.js version

You should receive a response within 72 hours. If you do not, please follow up.

## What to Expect

- We will acknowledge receipt of your report promptly.
- We will investigate and keep you informed of our progress.
- We will credit you in the fix unless you prefer to remain anonymous.
- We ask that you give us reasonable time to address the issue before any public disclosure.

## Scope

The following are in scope:

- The uplnk CLI (`packages/app`)
- The MCP tool execution path and command validation (`packages/app/src/lib/mcp/`)
- The secrets backend and API key storage (`packages/app/src/lib/secrets.ts`)
- Path traversal or allowlist bypass in file access tools

## Out of Scope

- Vulnerabilities in the user's LLM provider (Anthropic, OpenAI, Ollama, etc.)
- Issues requiring physical access to the user's machine
- Social engineering attacks

## Security Design Notes

uplnk is a local-first tool. It does not transmit your conversations or API keys to any third-party service. All data stays on your machine in `~/.uplnk/`. See the README for the full privacy architecture.
