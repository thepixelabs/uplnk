# Installing Pylon

Pylon is a terminal-native LLM developer assistant. It requires Node.js 20 or later
and a running LLM provider (Ollama, vLLM, LM Studio, or any OpenAI-compatible endpoint).

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
pylon
```

Or with pnpm:

```sh
pnpm add -g pylon-dev
pylon
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
pylon --version
pylon doctor
```

`pylon doctor` checks Node.js version, config directory writability, SQLite
database health, and Ollama reachability in one pass.

---

## Option 3: Homebrew (macOS / Linux)

Homebrew support is coming in v0.2.0. Once the tap is published:

```sh
brew tap pixelicous/tap
brew install pylon
```

For now, use the npm install above.

---

## Option 4: Docker

Docker support is planned post-MVP for users who prefer not to install Node.js
globally or who want to run Pylon alongside Ollama in a compose stack.

Once published:

```sh
docker run --rm -it \
  -v ~/.config/pylon:/root/.config/pylon \
  ghcr.io/pixelicous/pylon:latest
```

---

## Requirements

| Requirement | Minimum |
|-------------|---------|
| Node.js | 20.0.0 |
| npm | 9.0.0 |
| OS | macOS, Linux |
| LLM provider | Ollama, vLLM, LM Studio, or any OpenAI-compatible endpoint |

Pylon does not currently support Windows natively. WSL2 on Windows works.

---

## Quick start after install

```sh
# 1. Start your LLM provider (example: Ollama)
ollama serve &
ollama pull llama3.2

# 2. Verify everything looks good
pylon doctor

# 3. Start a conversation
pylon

# 4. Resume a previous conversation
pylon --conversation <id>

# 5. Pick a specific model
pylon --model llama3.2 --provider http://localhost:11434
```

---

## Upgrading

```sh
npm update -g pylon-dev
```

Pylon will also print a notice at startup when a newer version is available on npm.
Set `PYLON_UPDATE_CHECK=false` in your environment to suppress the notice.

---

## Uninstalling

```sh
npm uninstall -g pylon-dev
rm -rf ~/.config/pylon      # removes config and conversation database
```
