# Installing uplnk

uplnk is a terminal-native LLM developer assistant. It requires Node.js 20 or later
and a running LLM provider (Ollama, vLLM, LM Studio, or any OpenAI-compatible endpoint).

---

## Option 1: npx (no install, always latest)

```sh
npx uplnk
```

This downloads and runs the latest stable release without permanently installing anything.
Useful for one-off use or before committing to a global install.

---

## Option 2: Global npm install (recommended for daily use)

```sh
npm install -g uplnk
uplnk
```

Or with pnpm:

```sh
pnpm add -g uplnk
uplnk
```

### Stable channel (default)

```sh
npm install -g uplnk          # latest stable
```

### Pre-release channels

```sh
npm install -g uplnk@beta     # feature-complete, in testing
npm install -g uplnk@canary   # bleeding edge, every main-branch build
```

### Verify the install

```sh
uplnk --version
uplnk doctor
```

`uplnk doctor` checks Node.js version, config directory writability, SQLite
database health, and Ollama reachability in one pass.

---

## Option 3: Homebrew (macOS / Linux)

Homebrew support is coming in v0.2.0. Once the tap is published:

```sh
brew tap pixelicous/tap
brew install uplnk
```

For now, use the npm install above.

---

## Option 4: Docker

Docker support is planned post-MVP for users who prefer not to install Node.js
globally or who want to run uplnk alongside Ollama in a compose stack.

Once published:

```sh
docker run --rm -it \
  -v ~/.config/uplnk:/root/.config/uplnk \
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
npm update -g uplnk
```

uplnk will also print a notice at startup when a newer version is available on npm.
Set `UPLNK_UPDATE_CHECK=false` in your environment to suppress the notice.

---

## Uninstalling

```sh
npm uninstall -g uplnk
rm -rf ~/.config/uplnk      # removes config and conversation database
```
