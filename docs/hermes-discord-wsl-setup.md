# Hermes Discord WSL Setup

This is the local MVP setup for running Hermes from WSL, using Discord as the
collaboration surface and GitHub/Symphony as the workflow engine.

Current local discovery:

```text
Hermes binary: /home/amzimg/.local/bin/hermes
Hermes home:   /home/amzimg/.hermes
Config:        /home/amzimg/.hermes/config.yaml
Env:           /home/amzimg/.hermes/.env
Profiles:      default only
Gateway:       stopped
```

Do not commit `/home/amzimg/.hermes/.env`; it contains secrets.

## Discord Server Layout

Create one category:

```text
Hermes MVP
```

Create these channels inside it:

```text
#hermes-intake   user requests and spec discussion
#hermes-ops      status, failures, owner approvals
#hermes-reports  review HTML/report links
```

MVP recommendation:

- keep all three channels private
- give access only to the owner/admin group first
- enable Discord Developer Mode so you can copy channel IDs

Copy these IDs:

```text
DISCORD_INTAKE_CHANNEL_ID=
DISCORD_OPS_CHANNEL_ID=
DISCORD_REPORTS_CHANNEL_ID=
DISCORD_OWNER_USER_ID=
```

## Discord Bot

Create the bot in Discord Developer Portal:

1. Open `https://discord.com/developers/applications`.
2. New Application.
3. Bot page: create/reset token.
4. Enable privileged intents:
   - Server Members Intent
   - Message Content Intent
5. Installation/OAuth2:
   - scopes: `bot`, `applications.commands`
   - permissions: `274878286912`
6. Invite the bot to the server.

The bot appears offline until the WSL gateway is running.

## Hermes Gateway Config

Run interactive setup first:

```bash
wsl
hermes gateway setup
```

Choose Discord and paste:

- bot token
- allowed owner Discord user ID
- optional home channel: `#hermes-ops`

Then tighten the env in WSL:

```bash
nano ~/.hermes/.env
```

Use this shape:

```dotenv
DISCORD_BOT_TOKEN=...
DISCORD_ALLOWED_USERS=<owner_user_id>
DISCORD_HOME_CHANNEL=<ops_channel_id>
DISCORD_HOME_CHANNEL_NAME=Hermes Ops
DISCORD_ALLOWED_CHANNELS=<intake_channel_id>,<ops_channel_id>,<reports_channel_id>
DISCORD_REQUIRE_MENTION=true
DISCORD_THREAD_REQUIRE_MENTION=false
DISCORD_AUTO_THREAD=true
DISCORD_HISTORY_BACKFILL=true
DISCORD_REACTIONS=true
```

Keep `DISCORD_REQUIRE_MENTION=true` for MVP. It prevents Hermes from replying to
ordinary channel chatter unless explicitly tagged.

Optional config check:

```bash
hermes config check
hermes gateway list
```

Start the gateway in foreground from WSL:

```bash
hermes gateway run --replace
```

For WSL, foreground mode is easier to debug than installing a service.

Smoke test in Discord:

```text
@Hermes hello, reply with "gateway ok"
```

## Hermes Profiles

Current machine only has `default`. Create role profiles after Discord smoke
passes:

```bash
hermes profile create hermes-intake --clone --description "Collects user requests, asks clarifying questions, and writes GitHub intake comments."
hermes profile create hermes-spec --clone --description "Writes draft and final specs from GitHub issue context."
hermes profile create hermes-plan --clone --description "Breaks specs into GitHub task plans and subissues."
hermes profile create hermes-dev --clone --description "Implements scoped code changes and opens PRs."
hermes profile create hermes-test --clone --description "Runs tests and writes evidence without broad implementation changes."
hermes profile create hermes-review --clone --description "Reviews PRs and produces HTML reports."
```

Set each profile to start in this repo when it uses terminal tools:

```bash
hermes-dev config set terminal.cwd /mnt/c/Users/amzimg/Documents/symphony
hermes-test config set terminal.cwd /mnt/c/Users/amzimg/Documents/symphony
hermes-review config set terminal.cwd /mnt/c/Users/amzimg/Documents/symphony
hermes-spec config set terminal.cwd /mnt/c/Users/amzimg/Documents/symphony
```

Profiles separate Hermes state and memory. They do not sandbox filesystem
access, so keep GitHub protections and stage prompts in place.

## GitHub Labels

Create MVP labels once:

```bash
REPO=amzimg7890/fresh_food_butler

gh label create "hermes:intake" --repo "$REPO" --color 8A63D2 --description "Hermes intake" --force
gh label create "hermes:spec" --repo "$REPO" --color 1D76DB --description "Hermes spec" --force
gh label create "hermes:plan" --repo "$REPO" --color 5319E7 --description "Hermes plan" --force
gh label create "hermes:dev" --repo "$REPO" --color 0E8A16 --description "Hermes dev" --force
gh label create "hermes:test" --repo "$REPO" --color FBCA04 --description "Hermes test" --force
gh label create "hermes:review" --repo "$REPO" --color D93F0B --description "Hermes review" --force
gh label create "hermes:owner" --repo "$REPO" --color B60205 --description "Hermes owner approval" --force
gh label create "hermes:blocked" --repo "$REPO" --color 000000 --description "Hermes blocked" --force
gh label create "hermes:done" --repo "$REPO" --color C5DEF5 --description "Hermes done" --force
```

Run from a clone of the target repo or add `--repo owner/repo`.

## Symphony Stage Workers

This repo now has stage workflow files:

```text
WORKFLOW.hermes-spec.md
WORKFLOW.hermes-dev.md
WORKFLOW.hermes-test.md
WORKFLOW.hermes-review.md
```

Each workflow polls GitHub issues with one `hermes:*` label.

For MVP, run one stage worker at a time:

```powershell
npm run cli -- ./WORKFLOW.hermes-dev.md --run-for-ms 1800000
```

Or run separate workers with separate ports/logs:

```powershell
npm run cli -- ./WORKFLOW.hermes-spec.md --port 3011
npm run cli -- ./WORKFLOW.hermes-dev.md --port 3012
npm run cli -- ./WORKFLOW.hermes-test.md --port 3013
npm run cli -- ./WORKFLOW.hermes-review.md --port 3014
```

The stage worker does not currently read GitHub comments through the tracker, so
each prompt explicitly tells the worker to run:

```bash
gh issue view <number> --repo "$GITHUB_REPOSITORY" --comments
```

That is how it loads Hermes Context and previous handoffs.

## Create An Issue From Discord

Preferred MVP path: run the Router and let it create issues from Discord
messages.

Start the Router from the orchestrator repo:

```bash
npm run hermes:router -- \
  --workflow ./WORKFLOW.hermes-spec.md \
  --channel <hermes-intake-channel-id>
```

The first start initializes its state and ignores old messages. Leave it
running, then post a new message in `#hermes-intake`:

```text
!hermes intake 给 fresh_food_butler 增加首页提示。

目标：
显示 Hermes MVP smoke。

验收：
- README 或首页能看到 Hermes MVP smoke
- 需要留下 Hermes Handoff
- 不要修改无关文件
```

The Router will:

```text
read channel_id/message_id from Discord
create a GitHub issue with hermes:spec
write the hidden Hermes marker
reply in Discord with the issue URL
```

If you want to process an already-posted test message once:

```bash
npm run hermes:router -- \
  --workflow ./WORKFLOW.hermes-spec.md \
  --channel <hermes-intake-channel-id> \
  --once \
  --process-existing
```

Use `--dry-run` to preview without creating GitHub issues.

### Fallback Helper

If the Router is not running, you can still create an issue from a copied
Discord message link. You do not need to manually split `channel_id` and
`message_id`. Copy the Discord message link and let the helper parse it.

In Discord, right-click the request message in `#hermes-intake` and choose
`Copy Message Link`. Then run:

```bash
npm run workflow:hermes-create-issue -- \
  --workflow ./WORKFLOW.hermes-spec.md \
  --title "Hermes MVP smoke" \
  --body "Task:
Add a README note saying 'Hermes MVP smoke'.

Acceptance:
- README contains the exact text.
- Worker leaves a Hermes Handoff comment." \
  --discord-url "https://discord.com/channels/<server>/<channel>/<message>"
```

The first run is a dry run. If the preview is correct, add `--create`:

```bash
npm run workflow:hermes-create-issue -- \
  --workflow ./WORKFLOW.hermes-spec.md \
  --title "Hermes MVP smoke" \
  --body "Task:
Add a README note saying 'Hermes MVP smoke'.

Acceptance:
- README contains the exact text.
- Worker leaves a Hermes Handoff comment." \
  --discord-url "https://discord.com/channels/<server>/<channel>/<message>" \
  --create
```

The helper creates a GitHub issue with the `hermes:spec` label and this hidden
marker:

```md
<!-- hermes:{"source":"discord","channel_id":"...","thread_id":"...","message_id":"...","profile":"intake"} -->
```

## Manual MVP Loop

Until the Router exists as code, use this manual loop:

1. In Discord `#hermes-intake`, gather the request.
2. Create a GitHub issue with `workflow:hermes-create-issue -- --create`.
3. Run `WORKFLOW.hermes-spec.md`.
4. Read the `## Hermes Handoff` comment.
5. Move the label to the `next:` stage.
6. Repeat until `@hermes.owner`.
7. Owner approves in Discord/GitHub.
8. Move back to `hermes:spec` for final spec.
9. Add `hermes:done` and close the issue.

Label move command:

```bash
gh issue edit <number> --repo owner/repo --remove-label hermes:dev --add-label hermes:test
```

## Router Code Later

The first Router should only automate three things:

```text
parse ## Hermes Handoff
move GitHub labels
send Discord notification with hermes send
```

Use Hermes send for notifications:

```bash
hermes send --to discord:<ops_channel_id> "GH-123 ready for @hermes.test"
```

Skipped for MVP:

- webhook server
- job database
- automatic merge
- multi-profile gateway processes
