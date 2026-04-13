# Installing uplnk

uplnk is a terminal-native LLM developer assistant. It requires Node.js 20 or later
and a running LLM provider (Ollama, vLLM, LM Studio, or any OpenAI-compatible endpoint).

> The npm package is transitioning from `pylon-dev` to `uplnk`. Existing
> `npx pylon-dev` and `npm install -g pylon-dev` commands continue to work
> during the transition.

---

## Option 1: npx (no install, always latest)

```sh
npx pylon-dev
```

This downloads and runs the latest stable release without permanently installing anything.
Useful for one-off use or before committing to a global install.

---

## Option 2: Global npm install (recommended for daily use)

```sh
npm install -g pylon-dev
uplnk
```

Or with pnpm:

```sh
pnpm add -g pylon-dev
uplnk
```

### Stable channel (default)

```sh
npm install -g pylon-dev          # latest stable
```

### Pre-release channels

```sh
npm install -g pylon-dev@beta     # feature-complete, in testing
npm install -g pylon-dev@canary   # bleeding edge, every main-branch build
```

### Verify the install

```sh
uplnk --version
uplnk doctor
```

`uplnk doctor` checks Node.js version, config directory writability, SQLite
database health, and Ollama reachability in one pass. If you are upgrading
from a `pylon`-era install, `uplnk doctor` will also migrate `~/.pylon/` to
`~/.uplnk/` on first run.

---

## Option 3: Homebrew (macOS / Linux)

Homebrew support is planned. Once the tap is published:

```sh
brew tap pixelicous/tap
brew install uplnk
```

For now, use the npm install above.

---

## Option 4: Docker

Docker support is planned for users who prefer not to install Node.js
globally or who want to run uplnk alongside Ollama in a compose stack.

Once published:

```sh
docker run --rm -it \
  -v ~/.uplnk:/root/.uplnk \
  ghcr.io/pixelicous/uplnk:latest
```

---

## Requirements

| Requirement | Minimum |
|-------------|---------|
| Node.js | 20.0.0 |
| npm | 9.0.0 |
| OS | macOS, Linux |
| LLM provider | Ollama, vLLM, LM Studio, or any OpenAI-compatible endpoint |

uplnk does not currently support Windows natively. WSL2 on Windows works.

---

## Quick start after install

```sh
# 1. Start your LLM provider (example: Ollama)
ollama serve &
ollama pull llama3.2

# 2. Verify everything looks good
uplnk doctor

# 3. Start a conversation
uplnk

# 4. Resume a previous conversation
uplnk --conversation <id>

# 5. Pick a specific model
uplnk --model llama3.2 --provider http://localhost:11434
```

---

## Upgrading

```sh
npm update -g pylon-dev
```

uplnk will also print a notice at startup when a newer version is available on npm.
Set `UPLNK_NO_UPDATE=1` in your environment to suppress the notice.

---

## Uninstalling

```sh
npm uninstall -g pylon-dev
rm -rf ~/.uplnk      # removes config and conversation database
```
