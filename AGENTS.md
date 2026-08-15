# DSH Desktop repository rules

This repository owns the desktop product around an unmodified DeepSeek Harness checkout.

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- `dsh-plugin-desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Packaged update checks target this fork's GitHub Releases only; the upstream product service must never be contacted implicitly. Manual upstream merges follow [docs/upstream-policy.md](docs/upstream-policy.md).
- Every release tag requires a user-facing announcement at `docs/release-notes/<tag>.md`; `release-win.yml` refuses to publish without it. Fill it from `docs/release-notes/_TEMPLATE.md`.
- The `desktop-memory` row owns `MEMORY.md`/`USER.md` under the active profile's `memory/` directory. Its system-prompt snapshot is frozen per generation; tool writes must persist atomically without rebuilding that snapshot mid-generation.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).
