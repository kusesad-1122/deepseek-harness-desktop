# 上游跟进策略

English version: [upstream-policy.en.md](upstream-policy.en.md)

本仓库有两层上游，分别使用不同的隔离与跟进方式。本页是维护者的唯一操作手册：**默认不接收任何上游自动更新，只有维护者主动执行下面命令时，上游变更才会进入本项目。**

## 两层上游

| 层 | 上游仓库 | 在本仓库中的形态 | 当前 pin |
| --- | --- | --- | --- |
| Desktop 代码层 | [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) | 本仓库是其 GitHub fork；代码以合并/挑选方式跟进 | `origin` 远端为任意提交（分支策略见下） |
| Harness 核心层 | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `deepseek-harness/` 固定子模块 + [`upstream.json`](../upstream.json) 记录 pin | commit `47f943859bef60e4160492346772ded9b24f765a`（source `0.1.0-rc.5`） |

## 默认隔离保证（哪些事情“不会自动发生”）

1. **GitHub fork 不会自动同步。** GitHub 不会把 parent 仓库（anywhere-labs）的提交自动推进本 fork；只有维护者显式 `fetch`/`merge` 或点击网页上的 Sync fork 才会进入上游代码。
2. **应用内更新只检查本 fork 的 GitHub Releases。** `dsh-plugin-desktop/cordis.patch.yml` 把 `desktop-updates` 固定为：
   ```yaml
   source: github
   githubOwner: kusesad-1122
   githubRepo: deepseek-harness-desktop
   ```
   后台轮询、托盘手动检查、安装包下载都只与本 fork 的 Releases 交互。`updates.ts` 从 2.0.3 起还保证：`source: github` 配置不完整时**不会**回落到官方 `service` 端点；只有显式配置 `source: service` 才会联系 `dshdesktop.cn`。
3. **Harness 核心是固定子模块。** 子模块 checkout 指向 `upstream.json` 记录的 commit，`yarn install` 或普通 `git pull` 都不会移动它。

## 本仓库的 remote 约定

为避免误把上游当默认远端，维护环境应使用以下 remote：

| Remote | URL | 用途 |
| --- | --- | --- |
| `origin` | `https://github.com/kusesad-1122/deepseek-harness-desktop.git` | 日常 `git pull`/`git push`，默认只指向自己的 fork |
| `upstream` | `https://github.com/anywhere-labs/deepseek-harness-desktop.git` | 只读的上游参考，仅在主动跟进时使用 |

设置命令（已有环境也适用）：

```sh
git remote remove origin
git remote remove fork      # 若旧的 fork remote 存在
git remote add origin https://github.com/kusesad-1122/deepseek-harness-desktop.git
git remote add upstream https://github.com/anywhere-labs/deepseek-harness-desktop.git
git fetch upstream
```

## 按需跟进：Desktop 代码层

只在需要上游桌面修复或功能时执行。从当前工作分支创建合入分支，不要直接在发布分支上 merge：

```sh
git fetch upstream
git switch -c merge/upstream-desktop-YYYYMMDD origin/<你的基础分支>
git merge upstream/master --no-ff
```

合并后必须复查以下“分叉身份点”，因为上游每次都会把它们改写回 anywhere-labs：

- [ ] `dsh-plugin-desktop/cordis.patch.yml`：`desktop-updates` 仍指向本 fork 的 `githubOwner`/`githubRepo`；
- [ ] `dsh-plugin-desktop/package.json`：`repository.url` 仍是本 fork；
- [ ] `README.md` / `README.en.md`：stars badge 与本 fork 一致；
- [ ] 本页与 `docs/README.md` 索引未被上游文档覆盖删除；
- [ ] `upstream.json`、`.gitmodules`、`AGENTS.md` 规则没有被改写。

验证与提交：

```sh
corepack yarn install --immutable
corepack yarn check
git push origin merge/upstream-desktop-YYYYMMDD
```

> 如果只想取某个 commit，用 `git cherry-pick <sha>` 代替 `git merge`，保持“子模块 pin 更新”与“桌面行为改动”分属不同提交的仓库规则。

## 按需跟进：Harness 核心层

只有需要新核心能力或官方修复时执行。子模块 pin 变更必须独立成提交：

```sh
# 1. 查看上游 tag 与发布说明，选择一个明确版本
git -C deepseek-harness fetch --tags origin
git -C deepseek-harness log --oneline -5 FETCH_HEAD

# 2. 移动 pin（用 tag 或 commit）
git -C deepseek-harness checkout <tag-or-commit>

# 3. 验证：子模块自带 pnpm workspace 构建，外层桌面代码与测试保持不动
corepack yarn upstream:install
corepack yarn upstream:build
corepack yarn check

# 4. 更新 pin 记录（commit 用 git -C deepseek-harness rev-parse HEAD 取得）
#    编辑 upstream.json：commit / sourceVersion / runtimePackageVersion
git add deepseek-harness upstream.json
git commit -m "chore(upstream): pin deepseek-harness to <tag>"
```

回滚 pin 同理：checkout 旧 commit，恢复 `upstream.json` 中的记录，再提交。

## 只想彻底静默更新？

`desktop-updates` 的后台轮询可以关闭，托盘里的 “Check for Updates…” 手动入口仍然可用：

```yaml
# dsh-plugin-desktop/cordis.patch.yml 的 desktop-updates 行
config:
  enabled: false      # 不自动轮询；手动检查仍走本 fork Releases
```

这不会把更新源改回上游服务。

## 关于“要不要改名”

改名与收不收上游更新无关：fork 不会自动同步，应用内更新源与 git remote 才是决定因素，本页已经把两者隔离。如果将来出于品牌原因改名，改动点包括 GitHub 仓库名、`cordis.patch.yml` 的 `githubRepo`、README badge、包级 `repository` 字段与发布流水线；旧仓库 URL 会被 GitHub 301 重定向，但已安装客户端仍建议跟随一次新版本发布以落定新坐标。
