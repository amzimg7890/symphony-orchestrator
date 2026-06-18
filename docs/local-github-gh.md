# Local GitHub/gh Development Guide

这份文档说明如何在本地用 GitHub Issues 和 GitHub CLI (`gh`) 驱动
Symphony worker。这个路径不需要 Linear；issue tracker、workspace 准备、
评论和关闭 issue 都通过本机已登录的 `gh` 完成。

## Mental Model

本地 GitHub 模式的链路是：

```text
GitHub issue
  -> gh issue list
  -> Symphony tracker
  -> symphony_workspaces/GH-<number>
  -> codex app-server
  -> gh issue comment / gh issue close
```

`WORKFLOW.github.md` 是这条链路的入口。它会轮询 GitHub open issues，
筛选带指定 label 且分配给当前 worker 的 issue，然后为 issue 准备本地
workspace 并启动 Codex worker。

## Prerequisites

先确认本机具备这些条件：

```powershell
gh --version
gh auth status
node -v
npm -v
codex --version
```

如果 `gh auth status` 失败，先登录：

```powershell
gh auth login
```

`gh` 账号需要能读取目标仓库 issues，并且能创建 issue comment、关闭 issue。

## Environment

复制 `.env.example` 为 `.env`，至少设置这几项：

```dotenv
GITHUB_REPOSITORY=owner/repo
GITHUB_ASSIGNEE=your-github-login
SYMPHONY_REQUIRED_LABELS=codex
SYMPHONY_WORKSPACE_ENV_FILE=
SYMPHONY_WORKSPACE_ENV_TARGET=.env.local
```

当前项目的 GitHub workflow 默认读取：

- `GITHUB_REPOSITORY`: 目标仓库，格式为 `owner/repo`
- `GITHUB_ASSIGNEE`: 只处理分配给这个 GitHub 用户的 issue
- `SYMPHONY_REQUIRED_LABELS`: 通常保持 `codex`
- `SYMPHONY_WORKSPACE_ENV_FILE`: 可选，本机私密 env 模板文件，clone 后复制到每个 issue workspace
- `SYMPHONY_WORKSPACE_ENV_TARGET`: 可选，复制到 workspace 内的目标路径，默认 `.env.local`

`WORKFLOW.github.md` 里的 `tracker.repo` 指向 `$GITHUB_REPOSITORY`，
`tracker.assignee` 指向 `$GITHUB_ASSIGNEE`。如果 `GITHUB_ASSIGNEE` 留空，
就不会按 assignee 限制候选 issue。

目标仓库通常不会提交 `.env`。这种情况下，不要把 secret 写进 issue、
workflow 或仓库代码；在 Symphony 本机准备一个不进 Git 的 env 文件：

```text
C:\Users\you\Documents\symphony\secrets\owner-repo.env
```

然后在 Symphony 的 `.env` 里指向它：

```dotenv
SYMPHONY_WORKSPACE_ENV_FILE=C:\Users\you\Documents\symphony\secrets\owner-repo.env
SYMPHONY_WORKSPACE_ENV_TARGET=.env.local
```

每次 worker 准备 `symphony_workspaces/GH-<number>` 时，
`workspace:ensure-github` 会在 clone 或复用 checkout 后把这个文件复制成
workspace 内的 `.env.local`。日志只记录目标文件名，不记录 env 内容。

## Workflow Settings

本地 GitHub worker 主要依赖这些配置：

```yaml
tracker:
  kind: github
  repo: $GITHUB_REPOSITORY
  gh_command: gh
  assignee: $GITHUB_ASSIGNEE
  required_labels:
    - codex
  active_states:
    - Open
  terminal_states:
    - Closed
workspace:
  root: ./symphony_workspaces
hooks:
  before_run: npm --prefix ../.. run workspace:ensure-github --
agent:
  runner: codex
codex:
  command: codex app-server
  approval_policy: never
  turn_sandbox_policy:
    type: dangerFullAccess
```

`approval_policy: never` 和 `dangerFullAccess` 是本地无人值守 GitHub 写回的关键。
worker 需要在 issue workspace 中调用 `gh issue comment` 和 `gh issue close`；
如果使用默认安全策略，Windows 上常见结果是 `gh` 写操作卡在 approval 或被
command sandbox 拦截。

只在你信任当前仓库、当前 workflow 和 issue 来源时运行这个配置。

## Prepare An Issue

一个可被本地 worker 拉取的 GitHub issue 必须满足：

- issue 是 open
- 有 `codex` label
- 如果设置了 `GITHUB_ASSIGNEE`，issue 必须分配给该用户
- issue body 写清楚任务、验收标准和是否允许改文件

推荐 issue body 模板：

```markdown
Task:
Describe the exact change.

Acceptance:
- The worker can verify the result locally.
- Relevant tests or checks pass.

Constraints:
- Do not touch unrelated files.
- Leave a GitHub comment with proof of work.
- Close this issue when complete.
```

可以手动在 GitHub UI 创建 issue，也可以用 helper 创建一个 smoke issue：

```powershell
npm run workflow:prepare-github-issue -- --workflow ./WORKFLOW.github.md --create --create-labels
```

默认不带 `--create` 时，这个命令是只读 dry run：

```powershell
npm run workflow:prepare-github-issue -- --workflow ./WORKFLOW.github.md
```

它会检查 `gh auth status`、required labels、已有候选 issue，并打印建议的
`gh issue create` 命令。

## Check Readiness

启动 worker 前先跑只读检查：

```powershell
npm run workflow:check-github -- --workflow ./WORKFLOW.github.md
```

你希望看到：

```json
{
  "ok": true,
  "read_only": true,
  "github": {
    "eligible_candidate_count": 1,
    "candidate_issue_identifiers": ["GH-27"]
  },
  "ready_for_existing_issue_run": true
}
```

如果 `eligible_candidate_count` 是 `0`，通常是 issue 没有 label、assignee
不匹配、issue 已关闭，或 `.env` 指向了错误仓库。

## Run The Worker

本地开发最推荐 bounded run，避免 daemon 一直挂着：

```powershell
npm run cli -- ./WORKFLOW.github.md --run-for-ms 1800000
```

`1800000` 是 30 分钟。运行期间 Symphony 会：

1. 用 `gh issue list` 找候选 issue
2. 在 `symphony_workspaces/GH-<number>` 准备 workspace
3. 通过 `workspace:ensure-github` clone 或复用目标仓库 checkout
4. 启动 `codex app-server`
5. 把 issue title、URL、labels 和 body 渲染进 prompt
6. 让 worker 执行任务
7. 用 `gh issue comment` 留结果
8. 用 `gh issue close` 关闭完成的 issue

如果想打开本地 dashboard：

```powershell
npm run cli -- ./WORKFLOW.github.md --port 3001
```

然后访问：

```text
http://127.0.0.1:3001/
```

## Workspaces And Logs

GitHub issue workspace 默认在：

```text
symphony_workspaces/GH-<issue-number>
```

例如：

```text
symphony_workspaces/GH-27
```

结构化日志默认在：

```text
log/symphony-github.jsonl
```

常用排查命令：

```powershell
git -C symphony_workspaces/GH-27 status --short
Get-Content log/symphony-github.jsonl -Tail 80
gh issue view 27 --repo owner/repo --json number,state,comments,url
```

如果 worker 成功完成，你会看到：

- GitHub issue 上出现 worker 评论
- issue state 变成 `CLOSED`
- `workflow:check-github` 的 `eligible_candidate_count` 变为 `0`
- structured log 中出现 `run_terminated`，message 为 `terminal state`

## GitHub Actions

仓库内置手动 workflow：

```text
.github/workflows/symphony-github-issues.yml
```

在 GitHub Actions 页面手动运行：

- `check-only`: 只跑 `workflow:check-github`，不会启动 Codex，不会改 issue
- `run-worker`: 跑 bounded worker，会处理符合条件的 issue

Actions worker 需要 runner 上已经安装并可执行：

```text
codex app-server
```

GitHub-hosted runner 默认通常没有这个命令。实际使用时更适合 self-hosted runner，
或者在 workflow 里补齐 Codex 安装步骤。

## Troubleshooting

### `eligible_candidate_count` is 0

检查：

```powershell
gh issue list --repo owner/repo --state open --label codex
gh issue view <number> --repo owner/repo --json number,state,labels,assignees
```

常见原因：

- `.env` 的 `GITHUB_REPOSITORY` 错了
- issue 没有 `codex` label
- issue 没有分配给 `GITHUB_ASSIGNEE`
- issue 已经 closed

### `gh auth status` fails

重新登录：

```powershell
gh auth login
```

如果是 GitHub Enterprise，确认 `GITHUB_REPOSITORY` 使用 `host/owner/repo`
格式，并且 `gh` 已对该 host 登录。

### Worker starts but cannot update issue

确认 `WORKFLOW.github.md` 包含：

```yaml
codex:
  approval_policy: never
  turn_sandbox_policy:
    type: dangerFullAccess
```

缺少这两项时，本地无人值守 worker 可能无法执行 `gh issue comment` 或
`gh issue close`。

### Workspace is not cloned

手动运行 workspace helper：

```powershell
npm run workspace:ensure-github -- --repo owner/repo --workspace symphony_workspaces/GH-27
```

如果目录非空但不是 git checkout，helper 会拒绝覆盖。清理或换一个 workspace
后再试。

### Worker keeps running after issue is closed

bounded run 会等到 `--run-for-ms` 到期后退出。开发时可以直接 `Ctrl+C` 停止；
issue 已关闭后，下次 `workflow:check-github` 应显示候选数为 `0`。

## Command Cheat Sheet

```powershell
# Check local gh auth
gh auth status

# Dry-run GitHub workflow readiness
npm run workflow:check-github -- --workflow ./WORKFLOW.github.md

# Dry-run issue preparation
npm run workflow:prepare-github-issue -- --workflow ./WORKFLOW.github.md

# Create a smoke issue and missing labels
npm run workflow:prepare-github-issue -- --workflow ./WORKFLOW.github.md --create --create-labels

# Run local bounded worker for 30 minutes
npm run cli -- ./WORKFLOW.github.md --run-for-ms 1800000

# Run dashboard on port 3001
npm run cli -- ./WORKFLOW.github.md --port 3001

# Inspect a target issue
gh issue view <number> --repo owner/repo --json number,state,comments,url

# Inspect local issue workspace
git -C symphony_workspaces/GH-<number> status --short
```
