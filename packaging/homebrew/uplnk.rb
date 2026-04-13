class Uplnk < Formula
  desc "Terminal-native AI chat client — local-first, privacy-first"
  homepage "https://github.com/uplnk/uplnk"
  # url and sha256 are updated by the automated bump workflow on each release.
  # Do not edit these manually — they are managed by .github/workflows/bump-homebrew.yml
  # in the source repository.
  url "https://registry.npmjs.org/uplnk/-/uplnk-0.1.0.tgz"
  sha256 "PLACEHOLDER_REPLACE_ON_FIRST_PUBLISH"
  license :cannot_represent

  # Pin to Node 22 LTS (supported through April 2027).
  # uplnk requires Node >= 20; Node 22 is the current LTS and avoids churn
  # from Homebrew rolling `node` to a new major.
  depends_on "node@22"

  def install
    # std_npm_args installs to libexec/ with Homebrew prefix isolation,
    # preventing uplnk's node_modules from polluting the global npm tree.
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      uplnk requires a running LLM provider (Ollama, vLLM, LM Studio, or any
      OpenAI-compatible endpoint).

      Quick start::
        brew install ollama
        ollama serve &
        ollama pull llama3.2
        uplnk

      Verify your environment at any time with:
        uplnk doctor
    EOS
  end

  test do
    # Smoke test: --version must print the version string and exit 0.
    assert_match version.to_s, shell_output("#{bin}/uplnk --version")

    # Preflight check: doctor exit code is 0 only when all required
    # runtime dependencies are present.  In the Homebrew sandbox only
    # the Node.js check will pass (no Ollama), so we just assert the
    # binary runs without crashing on the Node version check.
    output = shell_output("#{bin}/uplnk doctor 2>&1", 1)
    assert_match "Node.js version", output
  end
end
