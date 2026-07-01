# Hermes/Symphony MVP Workflow

这份文档定义第一版能跑通的 Hermes + Symphony + GitHub + Discord/TG 协作闭环。
目标是先跑通流程，不先做完整平台。

## Goal

用 GitHub issue/PR 做唯一持久状态源，用 Hermes 处理频道协作和 tag 路由，用
Symphony 拉取 GitHub issue 执行阶段 worker。

```text
Discord/TG/GitHub command
  -> Hermes Router
  -> GitHub issue/comment/label
  -> Symphony GitHub tracker
  -> Codex/Hermes stage worker
  -> GitHub handoff comment
  -> Hermes Router advances label
  -> Discord/TG notification and assistance
```

## Non-Goals

- 不做独立 job database。
- 不做 agent 自由群聊。
- 不让 Discord/TG 保存流程真相。
- 不让 worker 直接决定通知谁或 merge。
- 不把 Hermes profile 当 sandbox；文件权限和工作目录单独控制。

## Source Of Truth

GitHub 保存所有 durable state：

- issue body: 原始需求和 Hermes marker
- issue labels: 当前阶段
- issue comments: intake、spec、handoff、approval
- PR: 代码变更
- repo files: spec、test evidence、review HTML

Discord/TG 是协作面：追问、总结、解释状态、触发命令、收集 owner 决策。

Symphony 是执行面：只拉取符合 label 的 GitHub issue，启动 worker。

Hermes Router 是控制面：解析 tag、鉴权、换 label、同步通知。

## Tags

第一版只保留这些 tag：

```text
@hermes.intake
@hermes.spec
@hermes.plan
@hermes.dev
@hermes.test
@hermes.review
@hermes.owner
```

对应 GitHub labels：

```text
hermes:intake
hermes:spec
hermes:plan
hermes:dev
hermes:test
hermes:review
hermes:owner
hermes:blocked
hermes:done
```

## Stage Boundaries

| Tag | Can | Cannot | Required Output |
| --- | --- | --- | --- |
| `@hermes.intake` | 追问、总结、创建/更新 issue comment | 改代码、写 final spec | intake comment |
| `@hermes.spec` | 写 draft spec；owner 批准后冻结 final spec | 改产品代码、merge | `docs/specs/GH-123.md` |
| `@hermes.plan` | 拆任务、创建子 issue、更新计划 comment | 改产品代码、merge | task graph/comment |
| `@hermes.dev` | 改代码、补必要测试、开 PR | approve、merge、冻结 spec | PR + handoff |
| `@hermes.test` | 跑测试、补/修测试、写 evidence | 大改产品实现、merge | test report |
| `@hermes.review` | review diff、产出 HTML report | 改产品代码、approve、merge | `reports/GH-123-review.html` |
| `@hermes.owner` | approve/reject/request changes、触发 final spec、merge | 静默改代码 | approval comment |

## Profile Mapping

Hermes profile 用来隔离身份、配置、memory、gateway state 和 toolsets。它不是
workspace，也不是 sandbox。

```yaml
tags:
  "@hermes.intake":
    profile: hermes-intake
    label: hermes:intake
    context: [channel_thread, issue, prior_comments]

  "@hermes.spec":
    profile: hermes-spec
    label: hermes:spec
    context: [issue, intake, prior_handoffs, owner_decision]

  "@hermes.plan":
    profile: hermes-plan
    label: hermes:plan
    context: [issue, spec, repo_tree]

  "@hermes.dev":
    profile: hermes-dev
    label: hermes:dev
    workflow: WORKFLOW.hermes-dev.md
    context: [issue, spec, plan, repo, prior_handoffs]

  "@hermes.test":
    profile: hermes-test
    label: hermes:test
    workflow: WORKFLOW.hermes-test.md
    context: [issue, spec, pr, diff, test_commands]

  "@hermes.review":
    profile: hermes-review
    label: hermes:review
    workflow: WORKFLOW.hermes-review.md
    context: [issue, spec, pr, diff, test_report]

  "@hermes.owner":
    profile: null
    label: hermes:owner
    context: [issue, spec, pr, test_report, review_html]
```

MVP 里 Symphony 只需要跑 `dev/test/review/spec` 这类实际 worker。`owner` 由人类
在 Discord/TG/GitHub 上确认。

## Context Bundle

Router 每次触发阶段时，组装一个 Context Bundle，写进 GitHub comment 或
worker prompt：

```md
## Hermes Context

stage: dev
issue: GH-123
source: discord
actor: alice
channel_thread: discord:C123/T456
spec: docs/specs/GH-123.md
plan: issue comment #456
pr:

Allowed:
- write product code
- open or update PR
- write handoff comment

Forbidden:
- merge
- owner approval
- final spec
```

长期项目规则放 `.hermes.md` / `AGENTS.md` / `CLAUDE.md`。阶段边界由 Router 注入，
不要写进全局规则。

## GitHub Marker

频道创建的 issue 在 body 里写一个隐藏 marker，用来把 GitHub 结果同步回原频道：

```md
<!-- hermes:{"source":"discord","channel_id":"C123","thread_id":"T456","message_id":"M789","profile":"intake"} -->
```

MVP 不建数据库。Router 通过 marker 找回 Discord/TG thread。

## Handoff Schema

每个 worker 结束必须写 GitHub comment：

```md
## Hermes Handoff

stage: dev
status: ready_for_test
next: @hermes.test
spec: docs/specs/GH-123.md
artifacts:
- PR: https://github.com/acme/repo/pull/123
- branch: codex/GH-123-login-fix
notes:
- Implemented the login retry guard.
- Local tests passed: npm test -- login
```

Router 只识别 `## Hermes Handoff`、`status`、`next`、`artifacts`。其余文本给人看。

## Label State Machine

```text
hermes:intake
  -> hermes:spec
  -> hermes:plan
  -> hermes:dev
  -> hermes:test
  -> hermes:review
  -> hermes:owner
  -> hermes:spec
  -> hermes:done
```

`owner -> spec` 是 final spec 阶段。final spec 完成后才允许 merge/release。

失败分支：

```text
dev blocked       -> hermes:spec or hermes:owner
test failed       -> hermes:dev
review changes    -> hermes:dev
owner rejected    -> hermes:spec or hermes:done
```

## Discord/TG Commands

普通用户：

```text
!hermes intake <request>
/hermes status GH-123
/hermes ask GH-123 <question>
```

Owner/admin：

```text
/hermes spec GH-123
/hermes plan GH-123
/hermes dev GH-123
/hermes test GH-123
/hermes review GH-123
/hermes approve GH-123
/hermes reject GH-123
```

所有命令只调用 Router。Discord/TG bot 不直接改 repo、不直接跑 shell。

MVP Router starts as a polling process:

```bash
npm run hermes:router -- --workflow ./WORKFLOW.hermes-spec.md --channel <hermes-intake-channel-id>
```

It watches new messages in `#hermes-intake`, accepts `!hermes intake ...`, and
creates a GitHub issue with the `hermes:spec` label.

## Notifications

Router 订阅两个来源：

```text
Symphony /api/v1/events        lifecycle updates
GitHub issue_comment webhook   worker handoff/comment content
```

通知规则：

```text
dispatch_started  -> "GH-123 started @hermes.dev"
run_blocked       -> "GH-123 blocked: ..."
worker_failed     -> "GH-123 failed: ..."
handoff next tag  -> "GH-123 ready for @hermes.test"
owner needed      -> "GH-123 needs approval"
done              -> "GH-123 done"
```

## Workflow Files

MVP 可以从 `WORKFLOW.github.md` 复制出阶段 workflow，只改 required label 和 prompt。

Example `WORKFLOW.hermes-dev.md`：

```yaml
tracker:
  kind: github
  repo: $GITHUB_REPOSITORY
  gh_command: gh
  assignee: $GITHUB_ASSIGNEE
  required_labels:
    - hermes:dev
agent:
  runner: codex
  max_concurrent_agents: 1
  max_turns: 3
codex:
  command: codex app-server
  approval_policy: never
  turn_sandbox_policy:
    type: dangerFullAccess
```

Dev prompt requirements:

```text
- Read Hermes Context, spec, and plan.
- Change only what the current stage requires.
- Open/update PR.
- Do not merge.
- Finish with a Hermes Handoff comment.
```

Test prompt requirements:

```text
- Read PR, spec, and test commands.
- Run the smallest relevant checks.
- You may add/fix tests.
- Do not make large product changes.
- Finish with test evidence and next=@hermes.review or next=@hermes.dev.
```

Review prompt requirements:

```text
- Review PR against spec and test evidence.
- Do not edit product code.
- Write reports/GH-123-review.html.
- Comment summary and next=@hermes.owner or next=@hermes.dev.
```

Spec prompt requirements:

```text
- If no owner approval exists, write/update Draft Spec.
- If owner approval exists, freeze Final Spec.
- Do not edit product code.
- Finish with handoff to plan/dev/done.
```

## Review HTML

`@hermes.review` writes:

```text
reports/GH-123-review.html
```

Minimum sections:

```text
Summary
Spec coverage
Changed files
Test evidence
Risks
Findings
Recommendation: approve | request_changes
```

GitHub comment and Discord/TG notification link to the report instead of
pasting the whole report.

## MVP Runbook

1. User writes in Discord/TG:

   ```text
   /hermes intake Fix login retry bug. Repro: ...
   ```

2. Router creates GitHub issue with marker and label `hermes:intake`.

3. Intake assistant asks missing questions, then writes intake comment.

4. Router moves label to `hermes:spec`.

5. Spec worker writes `docs/specs/GH-123.md` as Draft Spec and handoff
   `next: @hermes.plan`.

6. Plan worker writes task graph and handoff `next: @hermes.dev`.

7. Dev worker opens PR and handoff `next: @hermes.test`.

8. Test worker writes evidence and handoff:

   ```text
   next: @hermes.review
   ```

   If tests fail because implementation is wrong:

   ```text
   next: @hermes.dev
   ```

9. Review worker writes `reports/GH-123-review.html` and handoff
   `next: @hermes.owner`.

10. Owner approves in Discord/TG:

    ```text
    /hermes approve GH-123
    ```

11. Router writes approval comment and moves label to `hermes:spec`.

12. Spec worker freezes Final Spec and handoff `next: @hermes.done`.

13. Router moves label to `hermes:done`, closes issue, and notifies channel.

## First Smoke Test

Use a toy issue:

```text
Task: Add a README note saying "Hermes MVP smoke".
Acceptance:
- README contains the exact text.
- The PR includes a Hermes Handoff.
```

Pass condition:

- issue moves through `spec -> plan -> dev -> test -> review -> owner -> done`
- PR exists
- test evidence exists
- `reports/GH-123-review.html` exists
- Discord/TG thread receives start, blocked/fail if any, owner-needed, done

## Add Later

- job database for cross-repo audit and metrics
- signed report artifacts
- richer permissions per repo/channel/user
- automatic PR merge after owner approval
- Hermes Kanban if GitHub labels stop being enough
