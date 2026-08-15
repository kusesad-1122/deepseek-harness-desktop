# Upstream Follow Policy

[中文版本](upstream-policy.md)

This repository has two upstream layers, each isolated and followed in its own way. This page is the single operator manual: **no upstream update enters this project automatically; upstream changes land only when a maintainer runs the commands below on purpose.**

## Two upstream layers

| Layer | Upstream repository | Shape in this repo | Current pin |
| --- | --- | --- | --- |
| Desktop code | [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) | This repo is its GitHub fork; followed by explicit merge/cherry-pick | Any commit on `origin` (branch strategy below) |
| Harness core | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | Pinned submodule at `deepseek-harness/` plus [`upstream.json`](../upstream.json) | commit `47f943859bef60e4160492346772ded9b24f765a` (source `0.1.0-rc.5`) |

## Default isolation (what never happens automatically)

1. **A GitHub fork never auto-syncs.** GitHub never pushes parent (anywhere-labs) commits into this fork on its own; upstream code enters only through an explicit `fetch`/`merge` or the Sync fork button.
2. **In-app updates check this fork's GitHub Releases only.** `dsh-plugin-desktop/cordis.patch.yml` pins `desktop-updates` to:
   ```yaml
   source: github
   githubOwner: kusesad-1122
   githubRepo: deepseek-harness-desktop
   ```
   Background polling, the manual tray check, and installer downloads all talk to this fork's Releases. Since 2.0.3, `updates.ts` also guarantees that an incomplete `source: github` configuration **never** falls back to the official `service` endpoints; the service is contacted only when `source: service` is set explicitly.
3. **The Harness core is a pinned submodule.** The submodule checkout points at the commit recorded in `upstream.json`; neither `yarn install` nor an ordinary `git pull` moves it.

## Remote conventions

Keep the upstream repository away from the default remote:

| Remote | URL | Purpose |
| --- | --- | --- |
| `origin` | `https://github.com/kusesad-1122/deepseek-harness-desktop.git` | Daily `git pull`/`git push`; points only at this fork |
| `upstream` | `https://github.com/anywhere-labs/deepseek-harness-desktop.git` | Read-only reference, used only for explicit follow-ups |

Setup (also for existing environments):

```sh
git remote remove origin
git remote remove fork      # if the old fork remote exists
git remote add origin https://github.com/kusesad-1122/deepseek-harness-desktop.git
git remote add upstream https://github.com/anywhere-labs/deepseek-harness-desktop.git
git fetch upstream
```

## Follow on demand: Desktop code layer

Only when an upstream desktop fix or feature is wanted. Branch first; never merge directly into a release branch:

```sh
git fetch upstream
git switch -c merge/upstream-desktop-YYYYMMDD origin/<your base branch>
git merge upstream/master --no-ff
```

Re-check these fork identity points after every merge, because upstream rewrites them to anywhere-labs:

- [ ] `dsh-plugin-desktop/cordis.patch.yml`: `desktop-updates` still points at this fork's `githubOwner`/`githubRepo`;
- [ ] `dsh-plugin-desktop/package.json`: `repository.url` still points at this fork;
- [ ] `README.md` / `README.en.md`: stars badge matches this fork;
- [ ] This page and the `docs/README.md` index were not overwritten;
- [ ] `upstream.json`, `.gitmodules`, and the `AGENTS.md` rules were not rewritten.

Verify and publish:

```sh
corepack yarn install --immutable
corepack yarn check
git push origin merge/upstream-desktop-YYYYMMDD
```

> For a single commit, use `git cherry-pick <sha>` instead of `git merge`, and keep the repo rule that submodule pin updates stay in their own commit.

## Follow on demand: Harness core layer

Only when a new core capability or official fix is wanted. Pin changes must be their own commit:

```sh
# 1. Pick an explicit version from upstream tags or commits
git -C deepseek-harness fetch --tags origin
git -C deepseek-harness log --oneline -5 FETCH_HEAD

# 2. Move the pin (tag or commit)
git -C deepseek-harness checkout <tag-or-commit>

# 3. Verify: the submodule keeps its own pnpm workspace; desktop code stays untouched
corepack yarn upstream:install
corepack yarn upstream:build
corepack yarn check

# 4. Record the pin (commit from: git -C deepseek-harness rev-parse HEAD)
#    Edit upstream.json: commit / sourceVersion / runtimePackageVersion
git add deepseek-harness upstream.json
git commit -m "chore(upstream): pin deepseek-harness to <tag>"
```

Rolling back is the same procedure: checkout the old commit, restore `upstream.json`, commit.

## Want complete update silence?

Background polling can be disabled while the manual tray entry **Check for Updates…** keeps working:

```yaml
# desktop-updates row in dsh-plugin-desktop/cordis.patch.yml
config:
  enabled: false      # no automatic polling; manual checks still use this fork's Releases
```

This does not redirect updates to the upstream service.

## About renaming the project

Renaming is unrelated to receiving upstream updates: forks never auto-sync, and what actually matters is the in-app update source plus the git remotes — both isolated above. If you ever rename for branding reasons, the change points are the GitHub repo name, `githubRepo` in `cordis.patch.yml`, README badges, the package-level `repository` field, and the release pipeline. GitHub redirects the old URL with a 301, but installed clients should still get one follow-up release so the new coordinates settle in.
