# JulesBot Configuration Reference

JulesBot combines environment variables, a layered YAML configuration, runtime persona files, optional bootstrap files, and SQLite-backed guild mappings. This document describes what is loaded, where it applies, and which layer wins.

For runtime behavior, see [`ARCHITECTURE.md`](./ARCHITECTURE.md). For deployment/recovery, see [`OPERATIONS.md`](./OPERATIONS.md).

## Runtime files

A normal non-profile installation uses:

| File/path | Purpose | Git-tracked? |
| --- | --- | --- |
| `.env` | credentials and process-level environment | no |
| `config.yaml` | runtime routing/behavior overrides | no |
| `AGENTS.md` | global agent personality/guidelines | no |
| `SOUL.md` | global agent soul/principles | no |
| `bootstrap/` | extra prompt context, recursively loaded | no |
| `prisma/dev.db` | SQLite runtime state | no |
| `templates/config.example.yaml` | committed YAML defaults/reference | yes |
| `templates/AGENTS.example.md` | fallback/default agent persona | yes |
| `templates/SOUL.example.md` | fallback/default soul persona | yes |

`npm run setup` creates missing runtime files from the committed templates. It does not overwrite existing `config.yaml`, `AGENTS.md`, or `SOUL.md` unless its interactive `.env` reconfiguration path explicitly rewrites `.env`.

## Environment variables

| Variable | Required? | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | yes | none | Discord bot token |
| `JULES_API_KEY` | yes | none | Google Jules API key |
| `DATABASE_URL` | no | `file:./prisma/dev.db` | Prisma/SQLite location |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error` |
| `DEV_GUILD_ID` | no | none | register slash commands to one guild for immediate propagation |
| `HEALTHCHECK_PORT` | no | disabled | expose `GET /health` on this port |
| `BOT_PROFILE` | no | none | select a runtime profile (same purpose as `--profile <name>`) |
| `ALLOW_ALL` | legacy fallback | see note below | legacy access-control fallback |
| `ALLOWED_USERS` | legacy fallback | empty | comma-separated legacy user allowlist |
| `ALLOWED_ROLES` | legacy fallback | empty | comma-separated legacy role allowlist |

### Access-control environment variables

The shipped `templates/config.example.yaml` defines `access_control` explicitly, and that YAML default is always loaded before `config.yaml`. In a normal installation, **use `config.yaml` for access control**. The `ALLOW_ALL`, `ALLOWED_USERS`, and `ALLOWED_ROLES` environment variables are compatibility fallbacks for deployments where those YAML fields are absent; with the shipped template present they are normally shadowed by YAML values.

## Credentials at startup

JulesBot exits early if `DISCORD_TOKEN` or `JULES_API_KEY` is missing or still contains the template placeholder.

The Discord token is then exercised by the Discord gateway login. The Jules key is not proactively validated against the Jules API at every startup; it is exercised when Jules operations begin. The interactive setup wizard does perform a live Jules source-list validation when dependencies are available.

## Profiles

Use either:

```bash
npm start -- --profile pikachu
```

or:

```bash
BOT_PROFILE=pikachu npm start
```

The command-line `--profile` value wins over `BOT_PROFILE`.

When a profile is active, JulesBot creates `profiles/<name>/` if necessary and copies missing templates for:

- `.env`;
- `config.yaml`;
- `AGENTS.md`;
- `SOUL.md`;
- `bootstrap/` directory.

The profile `.env` is loaded **after** the root `.env` and overrides existing environment values.

### Profile database paths

If a profile has no `DATABASE_URL`, JulesBot defaults to:

```text
file:profiles/<name>/dev.db
```

If the profile `.env` contains a relative SQLite URL, the relative path is resolved **inside the profile directory**. For example the shipped `.env` template contains `file:./prisma/dev.db`, which becomes a database beneath `profiles/<name>/prisma/dev.db` when loaded as a profile setting.

Absolute SQLite paths remain absolute.

### Profile bootstrap fallback

A non-empty `profiles/<name>/bootstrap/` replaces the root `bootstrap/` source for that profile. If the profile bootstrap directory is empty, JulesBot currently falls back to the root `bootstrap/` directory.

That means profiles fully isolate bootstrap content only when the profile has at least one bootstrap file.

## When configuration changes take effect

Not every configuration source is live-reloaded:

- `.env`, `config.yaml`, `AGENTS.md`, and `SOUL.md` are loaded during process startup. Editing those files requires a restart before the running process sees the change.
- YAML `presence` is applied on Discord ready, so changing it also requires a reconnect/restart.
- SQLite guild mappings written by `/link-repo`, `/setup-forum`, and `/setup-chat` are queried during later routing events and can affect **new routing/session creation without a process restart** (unless a YAML `guilds:` value overrides them).
- `bootstrap/` files are read when `getBootstrapContext()` is called for new session construction, so changing bootstrap files can affect later newly-created normal sessions without reloading YAML/persona files. Existing Jules sessions keep the prompt/context they already received.
- Pre-warmed sessions also keep the prompt/persona/bootstrap they were created with until consumed.

Changing `default_repo`, `default_branch`, personality, diagnostic prompt, or other creation-time settings never rewrites an existing Jules backend session. Existing `DebugSession` rows continue pointing to their original Jules session/repository. New settings apply when a new session is created (or to later Discord-side presentation settings where the code resolves config again).

## YAML loading and validation

The committed `templates/config.example.yaml` is loaded first. Root/profile `config.yaml` is then layered over it.

JulesBot refuses to start if the user config:

- is not a YAML mapping at the top level;
- contains known foreign application keys such as `model_list` / `litellm_settings`; or
- is non-empty but contains no recognized JulesBot top-level key.

This is intentionally fail-stop. A syntactically valid but unrelated YAML file should not silently produce a Discord bot that appears online with incorrect routing/access defaults.

Unknown keys are not generally rejected when at least one recognized JulesBot key is present, so typos inside an otherwise valid config can still be ignored. Use the committed example as the canonical shape.

## Recognized top-level YAML keys

| Key | Global | Context override | Purpose |
| --- | :---: | :---: | --- |
| `diagnostic_prompt` | yes | yes | core Jules diagnostic instruction |
| `bot_emoji` | yes | yes | emoji used in status/plan text |
| `access_control` | yes | yes | allow/deny users/roles |
| `reactions` | yes | yes | lifecycle reaction emoji |
| `guilds` | yes | no | YAML guild repo/forum/chat mappings |
| `auto_reject` | yes | yes | automatic first-plan feedback |
| `jules_reactions` | yes | yes | allow Jules-authored reaction markers |
| `nudge` | yes | yes | one-shot unanswered-turn reminder |
| `jules_polling` | yes | **no** | process-wide scheduler/rate-limit budget |
| `interactive_selection` | yes | yes | repo/branch selection UI |
| `ignore_prefix` | yes | yes | ignore Discord messages starting with prefix |
| `presence` | yes | no | Discord presence/activity |
| `pre_warmed_sessions` | yes | yes | pre-warmed Jules pool behavior |
| `channels` | container | — | parent-channel / exact-thread override map |
| `roles` | container | — | role override map |
| `tags` | container | — | forum-tag override map |
| `messages` | yes | yes | user-facing text/prompt-fragment overrides |
| `default_repo` | yes | yes | repository fallback/routing override |
| `default_branch` | yes | yes | branch fallback/routing override |
| `typing_indicator_mode` | yes | yes | Discord typing behavior |
| `bootstrap` | yes | yes | include bootstrap context for normal session creation |
| `reply_mode` | yes | yes | how agent replies are delivered in Discord |
| `reply_context_mode` | yes | yes | how inbound reply references are represented in prompts |

`agents_personality` and `soul_personality` can be used inside channel/tag/thread/role overrides. Their global equivalents come from `AGENTS.md` and `SOUL.md`, not top-level YAML.

## Effective configuration precedence

For ordinary per-conversation settings, the precedence is:

```text
committed/code defaults
      ↓
global config.yaml
      ↓
parent channel override
      ↓
matching forum tag override(s)
      ↓
exact thread/channel override
      ↓
matching role override(s)
```

Later layers win. Nested structures such as `access_control`, `reactions`, `auto_reject`, `nudge`, `pre_warmed_sessions`, and `messages` are merged rather than requiring a complete replacement. **Arrays are replacement values, not unions:** if a more-specific `access_control.allowed_users` or `allowed_roles` array is present, it replaces the earlier array.

### Multiple tags

`tags:` can be keyed by forum tag **ID or name**. All matching tags are merged in the order they appear in the YAML object; later matching entries win shared fields.

Tag-name matching requires the parent forum's available-tag metadata to be present in the Discord.js cache. Tag IDs are the most robust keys.

### Multiple roles

`roles:` can be keyed by role **ID or name** when a full `GuildMember` is available. Matching role overrides accumulate in configuration order, with later matching roles winning shared fields.

For API interaction member payloads where Discord supplies role IDs as a plain array, ID keys are the reliable form.

## Guild routing and slash-command database settings

The slash commands `/link-repo`, `/setup-forum`, and `/setup-chat` write one `GuildConfig` row in SQLite.

`/link-repo` performs only basic `owner/repo` syntax validation before saving. It does not verify at command time that the repository is connected/accessible in Jules. `/setup-forum` and `/setup-chat` save the selected channel binding but do not perform a full runtime-permission/Jules readiness probe.

A YAML `guilds:` mapping can override those database values:

```yaml
guilds:
  "GUILD_ID":
    default_repo: "owner/repo"
    default_branch: "main"
    forum_channel_id: "FORUM_ID"
    chat_channel_id: "TEXT_CHANNEL_ID"
```

Operational implication: changing the database with a slash command does **not** override a conflicting YAML guild mapping. If startup logs show an unexpected repo/channel after running a setup command, check `config.yaml` first.

Changing `/link-repo` affects repository selection for **new** sessions only. Existing forum/chat `DebugSession` rows remain attached to the Jules session/repository they were originally created against.

### `channels:` can also admit forum parents

A forum thread is considered configured when either:

- its parent equals the guild's configured forum ID; **or**
- its parent ID exists as a key under `channels:`.

This allows multiple specifically configured forum parents without changing the single database `forumChannelId` field.

## Access control

Default template:

```yaml
access_control:
  allow_all: false
  silent: false
  allowed_users: []
  allowed_roles: []
```

This is deliberately **deny-by-default**. A fresh `npm run setup` copies this block into runtime `config.yaml`, so authorize at least one administrator/user/role before expecting the setup slash commands to work. The legacy `.env` example's `ALLOW_ALL=true` does not override these explicit YAML defaults.

Authorization order:

1. `allow_all: true` allows everyone.
2. In a forum thread, the **thread creator always has access to their own thread**.
3. A matching `allowed_users` ID allows the user.
4. A matching `allowed_roles` ID allows the current interacting user.
5. Otherwise access is denied.

### Forum role context: current implementation caveat

Forum role handling is not uniformly pinned to one member for the entire lifetime of a thread today.

- `hasPermission()` resolves the forum thread's access-control configuration using the **thread creator's** roles. The current interacting user's own role IDs are then checked against that resolved `allowed_roles` list.
- Initial forum session creation uses the starter-message member (normally the thread creator), so the prompt/personality/routing settings used to create the Jules session are creator-context.
- Several later message and interaction paths call `getEffectiveConfig(thread, currentMember)`. Role-specific `messages`, `reply_mode`, reactions, nudge settings, and some plan UI behavior can therefore resolve from the **current participant** instead.
- Some status/typing paths call `getEffectiveConfig(thread)` with no member, so they do not apply a role layer.

Do not assume every role override is an immutable creator-owned property of a forum thread. Creator context is authoritative for permission configuration and initial session creation; later presentation/delivery behavior can be participant-context depending on the call site.

Normal text channels have no thread owner, so role configuration is generally resolved against the current speaker.

### `silent`

For ordinary Discord messages, `silent: true` suppresses the permission-denied reply. Commands and component interactions use ephemeral error replies and do not use `silent` as a way to hide those errors.

### Command permissions are two layers

`/setup-forum`, `/setup-chat`, and `/link-repo` declare Discord's `Manage Server` (`ManageGuild`) permission as their default command permission **and** JulesBot runs its own `access_control` check before executing slash commands.

A guild administrator may therefore still be denied by JulesBot's own allowlist unless the effective bot access control authorizes them.

`/approve` has no `Manage Server` requirement but still requires JulesBot authorization and a mapped thread/session in the correct Jules state.

## `reactions`

Lifecycle reaction keys:

```yaml
reactions:
  queued: "⏳"
  in_progress: "⚙️"
  responded: "💬"
  awaiting_plan_approval: "📋"
  completed: "✅"
  failed: "❌"
```

Values can be Unicode or resolvable custom Discord emoji forms. An empty string disables that lifecycle reaction.

On reconnect, Jules state maps to stages as follows: `queued` → `queued`; `planning` / `inProgress` → `in_progress`; `awaitingPlanApproval` → `awaiting_plan_approval`; `completed` → `completed`; `failed` → `failed`. `responded` is event-driven from `agentMessaged`, not a session-state mapping. `awaitingUserFeedback` and `paused` currently have no reconnect reaction mapping, so JulesBot leaves the existing reaction unchanged in those states.

Whenever JulesBot applies a new lifecycle stage it removes reactions previously applied by the bot on that message before adding the configured stage. Jules-authored reactions follow the same replacement model; a later lifecycle transition can replace them again.

## `jules_reactions`

Opt-in feature:

```yaml
jules_reactions:
  enabled: true
```

When enabled, Jules receives an instruction explaining `[[react:EMOJI]]` markers. The marker is removed from the visible reply and applied as a real reaction to the user's Discord message.

Supported marker payloads include Unicode emoji, custom emoji tags, `name:id`, `:shortcode:`, and raw IDs when Discord can resolve them.

### Custom emoji names in normal Jules text

JulesBot also remaps custom emoji syntax in ordinary agent reply text against the bot's current Discord emoji cache. A full tag such as `<:party:OLD_ID>` can be rewritten to the cached emoji with the same name, and a matching `:party:` shortcode can become a full custom-emoji tag. If no cached custom emoji matches by name, the original text is left unchanged.

This is name-based remapping; duplicate custom emoji names across guilds can therefore be ambiguous from the bot's global emoji cache.

## `nudge`

```yaml
nudge:
  enabled: false
  after_minutes: 5
  notify_discord: true
  # message: "..."
  # discord_message: "..."
```

Only one nudge is scheduled for an active dispatched turn. It is cancelled when Jules sends a visible agent reply, exposes a plan, reaches a terminal state, or the queue is cleared.

The timer is process-local and is lost on restart.

## `jules_polling`

Process-global only:

```yaml
jules_polling:
  active_interval_ms: 5000
  idle_interval_ms: 60000
  idle_timeout_ms: 3600000
  max_concurrency: 3
  min_request_spacing_ms: 250
  rate_limit_base_delay_ms: 30000
  rate_limit_max_delay_ms: 300000
```

These values are loaded once at boot. They are **not** resolved through `channels:`, `tags:`, or `roles:`.

Only positive finite numbers are accepted; invalid/non-positive values fall back to defaults. `max_concurrency` is floored to an integer and never below 1.

The coordinator wraps Jules SDK operation entry points. One operation such as `activities.hydrate()` or iterating `client.sources()` can internally perform more than one HTTP request/page inside the SDK, so concurrency and spacing describe the operations JulesBot schedules rather than every internal request made by the SDK.

## `pre_warmed_sessions`

```yaml
pre_warmed_sessions:
  enabled: false
  pool_size: 1
  pre_warming_prompt: |
    ...
```

Pre-warming can be overridden by context, but the maintained pool scopes are narrower than the general config override model:

- startup provisioning/replenishment creates pools for the global context, configured `channels:` entries, and configured roles;
- there is no independently maintained forum-tag pool today, even though `pre_warmed_sessions` can appear inside a tag override;
- pre-warmed sessions are only consumed for the effective **default branch** (`default_branch` or `main`); a user-selected non-default branch creates a normal fresh session;
- if a matching pool entry exists but is still warming, a new thread waits in 5-second intervals for up to 12 checks (about 60 seconds) before continuing without that ready entry.

Ready entries persist in SQLite across restarts; still-warming entries are removed on the next startup. A ready pre-warmed session keeps the prompt/persona it was created with until consumed. If persona/config changes must take effect immediately, stale ready pool entries need to be cleared/cycled rather than merely restarting the bot.

Pre-warming consumes Jules quota and is intentionally off by default.

## `interactive_selection`

When `false` and a repo is resolvable, a new forum post starts directly on the effective repository/branch.

When `true`—or when no repository can be resolved—the bot lists Jules-connected repositories.

Discord menus are capped at 25 choices. Repository selection currently shows only the first menu-sized set (with the configured default repo inserted first when present); there is **no repository search/custom-repo action** in that menu. Branch selection is more capable: long branch lists reserve entries for Search and Custom Branch.

A manually entered custom branch name is passed to Jules session creation without a separate existence check, so a typo/nonexistent branch can fail when Jules tries to create the session.

Repository/source results are cached for 30 seconds per process. If a refresh fails and an older cache exists, JulesBot prefers that stale cache over returning nothing. If the source-list call fails with no cache, `getConnectedRepos()` currently logs the error and returns an empty list, which can make the interactive UI look like there are simply no connected repositories.

## `ignore_prefix`

Messages beginning with the configured prefix are ignored completely by `MessageCreate`:

```yaml
ignore_prefix: "!"
```

The check applies to configured forum conversations and the configured shared text channel. It is a simple `startsWith()` check on message content; attachment-only messages have no prefix to match.

Current resolver caveat: context overrides use a truthy check for `ignore_prefix`, so `ignore_prefix: ""` in a channel/tag/thread/role does **not** clear a non-empty global prefix. Use a different non-empty prefix or change the global value if you need different behavior.

## `presence`

Process-global Discord presence:

```yaml
presence:
  status: "online" # online | idle | dnd | invisible
  activity: "Diagnostic Logs"
  activity_type: "Watching" # Playing | Watching | Listening | Competing | Streaming | Custom
  # url: "https://twitch.tv/..." # useful/required for Streaming presence
```

Presence is applied after Discord login.

## `typing_indicator_mode`

Supported values used by the orchestrator:

- `until_response` (default): typing starts for user activity and stops when Jules sends an agent reply, plan, completion, or failure.
- `strict_state`: typing remains active through progress updates and stops only on terminal completion/failure.

Other strings are not rejected by config validation; they effectively fall through to the default branch of the orchestrator's behavior. Use the documented values.

## `reply_mode`

```yaml
reply_mode: "send"
```

Modes:

- `send` — post a normal message in the thread/channel;
- `reply_silent` — reply to the triggering Discord message without pinging its author;
- `reply_ping` — reply to the triggering message with normal Discord reply-mention behavior.

`send` is the default. YAML values are not enum-validated at startup: an unknown non-empty value is treated like a reply mode by the current delivery checks, and only the exact `reply_silent` value disables the replied-user mention. Use only the documented values.

## `reply_context_mode`

```yaml
reply_context_mode: "message_id"
```

Controls how Discord replies are represented in message prompts sent to Jules:

- `message_id` (default) — lightweight, synchronous ID referencing. Automatically tags each incoming message with `Message ID: <id>` and appends `, In reply to Message ID: <id>` to reply headers.
- `full_message` — asynchronously fetches the referenced message and prepends a quote snippet `[In reply to @Author (Message ID: <id>): "<snippet>"]`.
- `none` — ignores reply references completely.

## `bootstrap`


```yaml
bootstrap: true
```

For normal Jules session creation, `false` prevents `bootstrap/` content from being appended to the session prompt for that context.

**Current pre-warm caveat:** `PreWarmedManager.preWarmSession()` currently appends `getBootstrapContext()` whenever bootstrap content exists and does not consult the resolved `bootstrap` boolean. A context with `bootstrap: false` can therefore still get bootstrap content if it consumes a pre-warmed session. Treat that as current implementation behavior rather than assuming normal-session and pre-warm prompt assembly are identical.

Bootstrap loading itself:

- recursively reads **all files**, not only Markdown;
- sorts by relative path;
- inserts each file as `### FILE: bootstrap/<relative-path>` plus its contents;
- uses a non-empty profile bootstrap directory when available, otherwise falls back to root `bootstrap/`.

The helper `scripts/generate_bootstrap.js` has special/destructive behavior and is documented in [`MAINTAINER_TOOLS.md`](./MAINTAINER_TOOLS.md).

## Agent and soul personality

Global personality comes from:

- `AGENTS.md`, falling back to `templates/AGENTS.example.md`;
- `SOUL.md`, falling back to `templates/SOUL.example.md`.

Context overrides can use:

```yaml
channels:
  "CHANNEL_ID":
    agents_personality: |
      ...
    soul_personality: |
      ...
```

The same nested keys can be used under matching tags/threads/roles.

## `messages`

Runtime Discord message templates and substantive reusable Jules-prompt fragments live in `src/strings.ts` under `DEFAULT_MESSAGES`. Small computed/structural fragments (for example a formatted singular/plural delay unit) and setup/doctor CLI text can still live outside this catalog.

Categories:

- `errors`;
- `session`;
- `setup`;
- `plan`;
- `stream`;
- `commands`;
- `prompts`;
- `attachments`;
- `misc`.

Overrides are recursive/deep. You only need to specify the leaves you want to change:

```yaml
messages:
  errors:
    no_permission_session: "You cannot use this session."
  plan:
    approve_button: "Continue"
```

Templated strings contain placeholders such as `{repo}`, `{branch}`, `{emoji}`, `{error}`, `{feedback}`, `{count}`, and `{url}`. Preserve placeholders that the message still needs.

The renderer is single-pass: replacement values are not interpreted as new template syntax.

## Attachments

There is no separate attachment config toggle. Attachment-only messages are accepted in supported conversations.

JulesBot appends a configurable metadata block from `messages.attachments` containing attachment name, Discord URL, MIME type (when known), and size. The default prompt tells Jules to download the attachment into its own workspace if inspection is needed.

## Repository and branch precedence

Repository selection has a few extra sources beyond the normal override chain:

- slash-command database `GuildConfig.defaultRepo` is a fallback source;
- global YAML `default_repo` can supersede that fallback;
- YAML `guilds.<id>.default_repo` supersedes the guild database mapping;
- parent channel, tag, exact thread, and role overrides can then supersede the resolved repo.

Branch selection uses global `default_branch`, optional YAML guild `default_branch`, then parent/tag/thread/role overrides, finally falling back to `main` when a session is created.

## Channel/tag/role example

```yaml
access_control:
  allow_all: false
  allowed_users: ["123"]
  allowed_roles: []

channels:
  "FORUM_ID":
    access_control:
      allow_all: true
    default_repo: "owner/support-repo"

    # This parent is also treated as an allowed forum parent.

  "ONE_SPECIFIC_THREAD_ID":
    reply_mode: "reply_silent"

tags:
  "bug":
    default_branch: "develop"
  "urgent":
    nudge:
      enabled: true
      after_minutes: 2

roles:
  "Developer":
    interactive_selection: true
    typing_indicator_mode: "strict_state"
```

For a Developer-created forum post tagged `bug` and `urgent`, the effective configuration layers parent channel → both matching tags in YAML order → exact thread override if present → Developer role override.

## Presence of runtime files vs committed templates

Do not edit `templates/*.example.*` on a production server to customize one instance. Templates are Git-tracked defaults and can change on pull.

Instance-specific behavior belongs in gitignored runtime files (`config.yaml`, `.env`, `AGENTS.md`, `SOUL.md`, `bootstrap/`) or a profile directory. Back those files up separately; Git cannot recover them.
