# Jules Agent — Tool Notes

> [!IMPORTANT]
> **Operational Environment**: Jules runs on an **isolated cloud VM**, not on the current local device. It cannot access your local filesystem or network directly. All work must be performed via the Jules API.

You have access to `jules-agent`, a CLI tool for delegating coding tasks to **Jules** (Google's autonomous AI coding agent). Use Jules to embark on coding tasks or general code changes. While you cannot make Pull Requests directly, Jules can research, implement changes, and create PRs for you via the Jules REST API.

## Location & Invocation

```bash
node /workspace/jules-skill/bin/jules-agent.js <command> [args...]
```

All output is **JSON**. Parse it with `jq` or read it directly. Exit code `0` = success, `1` = error.

## Configuration

### Configuration (`.config.json`)

```json
{
  "apiKey": "your-api-key",
  "defaultSource": "sources/github-owner-repo",
  "defaultBranch": "main",
  "defaults": {
    "requireApproval": true,
    "autoPR": false
  }
}
```
- **`apiKey`** — API key for Jules. Fallback: `JULES_API_KEY` env var.
- **`defaultSource`** — set this once so you don't need `--source` every time
- **`defaultBranch`** — branch to start sessions from (default: `main`)
- **`requireApproval`** — `true` by default so you always get to review Jules's plan before execution
- **`autoPR`** — `false` by default; set to `true` to auto-create PRs on completion

## Typical Workflow

1. **Create a session** — for short prompts use `--prompt`, for detailed tasks use `--prompt-file`:
   ```bash
   # Short prompt
   node /workspace/jules-skill/bin/jules-agent.js create --prompt "Add unit tests for the auth module"

   # Long/multiline prompt — write task to a file first, then pass the path
   node /workspace/jules-skill/bin/jules-agent.js create --prompt-file /tmp/task.txt --title "Auth refactor"
   ```
   Returns session object with `id` and `state` fields.

2. **Check session status**:
   ```bash
   node jules-agent/bin/jules-agent.js status <sessionId>
   ```
   Key field: `state` — one of: `QUEUED`, `PLANNING`, `AWAITING_PLAN_APPROVAL`, `AWAITING_USER_FEEDBACK`, `IN_PROGRESS`, `PAUSED`, `COMPLETED`, `FAILED`.

3. **Approve a plan** (when state is `AWAITING_PLAN_APPROVAL`):
   ```bash
   node jules-agent/bin/jules-agent.js approve <sessionId>
   ```

4. **Send a message** to guide Jules mid-session:
   ```bash
   node jules-agent/bin/jules-agent.js message <sessionId> "Please also update the README"
   ```

5. **View activities** (progress, messages, code diffs):
   ```bash
   node jules-agent/bin/jules-agent.js activities <sessionId>
   ```

6. **View a specific activity** (e.g., to inspect code patches):
   ```bash
   node jules-agent/bin/jules-agent.js activity <sessionId> <activityId>
   ```

## All Commands

| Command | Purpose |
|---------|---------|
| `sources` | List connected GitHub repos |
| `source <id>` | Get repo details and branches |
| `create --prompt "..."` | Start a session with an inline prompt |
| `create --prompt-file <path>` | Start a session with prompt from a file (best for long tasks) |
| `sessions` | List all sessions |
| `status <id>` | Get session state and outputs |
| `approve <id>` | Approve a pending plan |
| `message <id> "text"` | Send a message to an active session |
| `activities <id>` | List all events in a session |
| `activity <sid> <aid>` | Get a single activity's details |
| `delete <id>` | Delete a session |
| `help` | Show JSON command reference |

## Create Command Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--prompt` | — | Inline prompt string (for short tasks) |
| `--prompt-file` | — | Read prompt from a file path. Use `-` for stdin. Best for long/multiline task descriptions. |
| `--source` | from config | Override default repo |
| `--branch` | from config | Override default branch |
| `--title` | (auto) | Session title |
| `--require-approval` | `true` (config) | Force plan approval on |
| `--no-approval` | — | Force plan approval off |
| `--auto-pr` | `false` (config) | Auto-create PR on completion |

## Tips

- **Use `--prompt-file` for detailed tasks.** Write multi-line instructions, code references, and acceptance criteria to a temp file, then pass it. Avoids shell escaping issues.
- **Write clear, specific prompts.** Include file paths, function names, and expected behavior.
- **Poll `status`** periodically. When `COMPLETED`, check `outputs` for PR URLs.
- **Use `--after TIMESTAMP`** with `activities` to fetch only new events since last check.
- **Check activities** after completion to review code diffs and test output.

## Bugfix Policy

> [!IMPORTANT]
> **Verify before fixing**: Only proceed with a bugfix if the issue described **exists on the `main` branch**. 
>
> Pikachu (the AI) now works directly with the latest **main branch**. However, users are typically on the **latest release tag** which may contain bugs that have already been resolved in `main`. Before tasking Jules with a fix, do a quick check of the currently merged PRs to see if the fix has already been implemented, and clearly instruct Jules to verify the bug's existence on the `main` branch before implementing changes.
