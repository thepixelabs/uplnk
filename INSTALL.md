# Installing uplnk

uplnk is a terminal-native LLM developer assistant. Self-contained binaries, no Node.js or runtime required.

## Option 1: Homebrew (macOS / Linux)

```sh
brew install thepixelabs/tap/uplnk
uplnk
```

This is the recommended path. Works on macOS (Apple Silicon and Intel) and Linux (arm64 and x86_64) via Linuxbrew.

To upgrade:

```sh
brew upgrade uplnk
```

## Option 2: Direct binary download (Linux / macOS)

If you don't have Homebrew, download the prebuilt binary for your platform from the [latest release](https://github.com/thepixelabs/uplnk/releases/latest). Each release ships:

- `uplnk-darwin-arm64`, `uplnk-darwin-x64`
- `uplnk-linux-arm64`, `uplnk-linux-x64`
- `uplnk-win-x64.exe`

Each binary has an accompanying `.sha256` for checksum verification.

```sh
# Linux x64 example — adjust the asset name for your platform
curl -L https://github.com/thepixelabs/uplnk/releases/latest/download/uplnk-linux-x64 \
  -o /usr/local/bin/uplnk
chmod +x /usr/local/bin/uplnk
uplnk
```

For Apple Silicon: `uplnk-darwin-arm64`. For Intel macOS: `uplnk-darwin-x64`. For Windows: download `uplnk-win-x64.exe` and place it on your `PATH`.

### Verify the install

```sh
uplnk --version
uplnk doctor
```

`uplnk doctor` checks the config directory, SQLite database health, and reachability of your configured LLM provider in one pass.

## Requirements

| Requirement | Minimum |
|-------------|---------|
| OS | macOS, Linux, Windows (x64) |
| LLM provider | Ollama, vLLM, LM Studio, or any OpenAI-compatible endpoint |

The standalone binary bundles its runtime — no Node.js, Bun, or other interpreter is required on the host.

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

## Upgrading

Homebrew:

```sh
brew upgrade uplnk
```

Direct binary: re-download the latest from the [releases page](https://github.com/thepixelabs/uplnk/releases/latest) and overwrite the binary at the path above.

## Uninstalling

Homebrew:

```sh
brew uninstall uplnk
rm -rf ~/.config/uplnk      # removes config and conversation database
```

Direct binary:

```sh
rm /usr/local/bin/uplnk
rm -rf ~/.config/uplnk
```

## A note on npm

uplnk was previously distributed via npm (`npm install -g uplnk`). The npm package has been retired in favour of self-contained binaries — those required a Bun runtime on the host, while the current binary distribution does not. Old npm versions are deprecated; please install via Homebrew or direct binary download.
