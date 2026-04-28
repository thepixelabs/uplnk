/**
 * @type {import('semantic-release').GlobalConfig}
 *
 * semantic-release config for the uplnk monorepo.
 *
 * Publishing discipline:
 *   - semantic-release runs on every push to main.
 *   - It reads the conventional commit log since the last release tag.
 *   - If there are releasable commits it: bumps version in packages/app/package.json,
 *     writes CHANGELOG.md at the repo root, commits both files back to main, and
 *     creates a GitHub Release tagged vX.Y.Z.
 *   - The GitHub Release "published" event then triggers bump-homebrew.yml.
 *
 * npm publishing — RETIRED:
 *   The npm channel is permanently retired in favour of binary distribution
 *   (build-binaries.yml + Homebrew via bump-homebrew.yml). The @semantic-release/npm
 *   plugin is kept in the chain because it bumps the version field in
 *   packages/app/package.json, which @semantic-release/git then commits back to main
 *   and which the binary build embeds. npmPublish stays false; we never push to npm.
 *
 * pkgRoot:
 *   Points @semantic-release/npm at packages/app so it reads and writes the correct
 *   package.json. Even with npmPublish: false the plugin still bumps the version field.
 *   @semantic-release/git then commits the bumped packages/app/package.json back to main.
 */
module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { type: "feat",     release: "minor" },
          { type: "fix",      release: "patch" },
          { type: "perf",     release: "patch" },
          { type: "refactor", release: "patch" },
          { type: "revert",   release: "patch" },
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        presetConfig: {
          types: [
            { type: "feat",     section: "Features" },
            { type: "fix",      section: "Bug Fixes" },
            { type: "perf",     section: "Performance Improvements" },
            { type: "refactor", section: "Code Refactoring" },
            { type: "docs",     section: "Documentation" },
            { type: "style",    section: "Styling",       hidden: true },
            { type: "test",     section: "Tests",         hidden: true },
            { type: "build",    section: "Build System",  hidden: true },
            { type: "ci",       section: "CI/CD",         hidden: true },
            { type: "chore",    section: "Miscellaneous", hidden: true },
          ],
        },
      },
    ],
    [
      "@semantic-release/changelog",
      {
        // Changelog lives at the repo root for discoverability.
        changelogFile: "CHANGELOG.md",
      },
    ],
    [
      "@semantic-release/npm",
      {
        // npmPublish is false here — the actual publish runs in a separate
        // release.yml step so we can pass --provenance via pnpm publish.
        // This plugin still bumps the version field in packages/app/package.json.
        pkgRoot: "packages/app",
        npmPublish: false,
      },
    ],
    [
      "@semantic-release/git",
      {
        // Commit the bumped package.json and updated CHANGELOG back to main.
        // pnpm-lock.yaml is intentionally omitted — semantic-release does not run
        // pnpm install, so the lockfile is not updated; including a stale lockfile
        // would cause CI to fail on the next run.
        assets: ["packages/app/package.json", "CHANGELOG.md"],
        message:
          "chore(release): ${nextRelease.version}\n\n${nextRelease.notes}",
      },
    ],
    // Creates the GitHub Release and uploads assets. The "published" event from
    // this release then triggers bump-homebrew.yml.
    "@semantic-release/github",
  ],
};
