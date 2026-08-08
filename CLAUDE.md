# CLAUDE.md

Guidance for AI coding agents working on **JulesBot**. Keep this current as the code changes.

## What this is

JulesBot is a Discord bot that turns each **forum thread** into an interactive **Google Jules**
coding-agent session. It can also bind one normal text channel per guild as a shared conversational
chatbot. Forum sessions stream live activity and gate plans behind **Approve / Reject** buttons;
text-channel sessions listen to every human message, suppress progress UI, and redirect plans into
direct replies.

Stack: **TypeScript (ESM) · discord.js v14 · @google/jules-sdk · Prisma v7 + SQLite (better-sqlite3)**.

## Commands

- `npm run dev` — run from source via tsx (`prisma generate && tsx src/index.ts`). Primary dev loop.
- `npm run build` — `tsc` → `dist/`. **Use this to typecheck** (strict mode is on).
- `npm run start` — run compiled output (`node dist/index.js`). Production (`pm2` is a dependency).
- `npm run setup` — interactive first-run wizard: prompts for + validates the tokens, prints the bot invite
  URL, copies `templates/*` → root runtime files, installs deps, provisions the DB, offers to start. `--yes`
  (or any non-TTY shell) runs non-interactively with tokens from env. `npm run doctor` is a pre-flight check.
- `npm run db:migrate` — `prisma migrate dev` (run after editing `prisma/schema.prisma`).
- `npm run db:generate` — regenerate the Prisma client.
- `npm run lint` / `npm run format` — ESLint + Prettier (CI-gated; `format:check` to verify without writing).
- `npm test` — `node:test` suite over the pure utils, conversation turn queue, `strings.ts`, the
  `getEffectiveConfig` precedence resolver, the `hasPermission` allowlist, and the level-gated `logger`
  (`test/*.test.ts`). The
  config/permissions suites import `config.ts`; `test/_ensureDb.ts` (imported *before* `config.js`) keeps them
  DB-free by pre-creating an empty SQLite file so no provisioning runs. No integration coverage of the
  Discord/Jules round-trip, so also verify with `npm run build` + a manual `npm run dev`.
- CI (`.github/workflows/ci.yml`) runs `npm run build` + `npm run lint` + `npm run format:check` + `npm test`
  on every push/PR to `main`.

Required env (`.env`): `DISCORD_TOKEN`, `JULES_API_KEY`, `DATABASE_URL` (defaults to `file:./prisma/dev.db`).
If the SQLite file is missing, `src/config.ts` auto-provisions it on boot via `npx prisma migrate deploy`
(falling back to `db push`); `prisma` is a runtime dependency so this works under `npm ci --omit=dev`.

## ⚠️ Repo-specific landmines

1. **ESM with explicit `.js` import extensions.** `tsconfig` uses `module`/`moduleResolution: Node16`
   and the package is `"type": "module"`. Every relative import must end in `.js` even though the file
   is `.ts` — e.g. `import { prisma } from '../config.js'`. Omitting it breaks build/runtime. Match the existing style.
2. **`AGENTS.md` and `SOUL.md` are runtime config, not docs.** They are **gitignored** and read by
   `src/config.ts` into `AGENT_PERSONALITY` / `SOUL_PERSONALITY`, then injected into *every* Jules session
   prompt (`src/lib/jules/JulesClient.ts`). Do **not** put codebase/agent docs there — that's why this file
   is `CLAUDE.md`. Edit the committed persona defaults in `templates/AGENTS.example.md` / `templates/SOUL.example.md`.
3. **Resolve per-thread settings through `getEffectiveConfig(thread?, member?)`** (`src/config.ts`).
   Precedence: global YAML → parent-channel override → tag override (forum post's applied tags) →
   thread override → role override. Don't read `yamlConfig.*` directly when behavior should vary by
   channel/tag/role.
4. **Module-level state is process-local and lost on restart.** `activeStreams`, `autoRejectedSessions`,
   `processedActivityIdsMap` (orchestrator), conversation queues/nudge timers, scheduler watcher state, and
   `StreamManager`'s buffers/timers do not survive a restart. Persisted truth lives in SQLite (`DebugSession`).
   On boot `rehydrateActiveStreams()` considers at most 10 sessions updated in the last 24 hours; sessions
   older than the configured idle grace period are checked and left dormant when already idle/terminal.
   Any mapped thread/channel can still reattach on its next Discord action. Anything new you add to module
   state must tolerate restarts / serverless pauses.
5. **Discord 2000-char limit.** Use `splitMessage()` (`src/lib/utils/messageSplitter.ts`) for agent output.
   `StreamManager` keeps the primary status message editable and synchronizes overflow into reusable silent
   replies instead of truncating long progress or final-status content.
6. **Prisma uses a driver adapter.** `prisma/schema.prisma`'s `datasource` has **no `url`** — it comes from
   `prisma.config.ts` / `DATABASE_URL` plus the `@prisma/adapter-better-sqlite3` adapter in `src/config.ts`.
   Export `DATABASE_URL` when running raw `prisma` CLI commands.

## Architecture / request flow

Forum thread created → isolated Jules session → live stream into Discord → human gates the plan.
Configured text-channel message → shared Jules session → direct conversational replies.

```
ThreadCreate ─▶ (optional repo/branch select) ─▶ initializeJulesSession ─▶ JulesClient.createSession
                                                        │                          │
MessageCreate ─▶ session.send(prompt + metadata)        ▼                          ▼
InteractionCreate (buttons/menus/modals) ───────▶ JulesRequestCoordinator
                                                        │
                                                        ▼
                                                ActivityPollScheduler
                                                active 5s / idle 60s
                                                        │
                                                        ▼
                                                runJulesStream
                                                        │
                          StreamManager (status msg) · reactions · Approve/Reject plan embeds
```

Key modules:

- `src/index.ts` — client bootstrap, intents (Guilds, GuildMessages, **MessageContent**), event wiring,
  global slash-command registration on ready, `initPreWarmedPools()` + `rehydrateActiveStreams()`, presence.
  Has process-level `unhandledRejection` / `uncaughtException` guards.
- `src/events/threadCreate.ts` — gate on the configured forum channel; optional interactive repo/branch
  pickers; otherwise `initializeJulesSession`.
- `src/events/messageCreate.ts` — queue forum-thread and configured text-channel messages per channel, then
  forward one turn at a time to the mapped/shared session only after the previous turn terminates. Rehydrates
  inactive streams, pins replies to the active Discord message, and honors `ignore_prefix`.
- `src/events/interactionCreate.ts` — buttons (`plan-approve` / `plan-reject`), select menus
  (`select-repo` / `select-branch`), and branch search/custom modals. Note the Discord **25-option** menu cap handled here.
- `src/lib/jules/orchestrator.ts` — **core.** `runJulesStream` (persisted delivery cursor, bounded activity
  polling, typing indicators, reactions, plan embeds, response-nudge scheduling, plan-feedback flow,
  completion-result fallback), `initializeJulesSession` (creation + pre-warmed consumption + welcome-plan
  handling), and `rehydrateActiveStreams`. Non-rate-limit failures still use the legacy bounded retry path;
  Jules 429s are handled centrally and do **not** consume that retry budget.
- `src/lib/jules/ActivityPollScheduler.ts` — process-wide scheduler for active/idle watcher timing,
  concurrency, minimum request spacing, idle expiry, and shared exponential+jittered 429 cooldown.
- `src/lib/jules/JulesRequestCoordinator.ts` — singleton scheduler/request budget. Route Jules network work
  through `scheduleJulesRequest()` (or the scheduler's `poll()` path) rather than calling SDK network methods
  directly from unrelated modules.
- `src/lib/jules/ConversationQueue.ts` — process-local per-channel turn queue. Tracks enqueue, dispatch,
  first-response, one-shot nudge, and completion timestamps. Any non-empty `agentMessaged` response releases
  the active turn so the next queued message can be sent. Nudge timers cancel on an agent reply, visible plan,
  terminal activity, or queue cleanup; successful nudges can post a configurable Discord notice.
- `src/lib/jules/JulesClient.ts` — thin `@google/jules-sdk` wrapper. Builds the full prompt =
  `diagnostic_prompt` + persona + soul + bootstrap + user issue. `createSession` / `getSession` / `getConnectedRepos`.
- `src/lib/jules/PreWarmedManager.ts` — pre-warmed session pools to hide clone/queue latency
  (`preWarmSession`, `replenishPool`, `initPreWarmedPools` — which on startup removes only **orphaned
  still-warming** sessions and **preserves `ready` ones** across restarts, then tops the pool back up).
- `src/lib/streams/StreamManager.ts` — one editable "status message" per thread; buffers progress lines,
  debounced 3s flush, `finalizeSession`.
- `src/lib/utils/` — `permissions.ts` (allowlist + thread-creator context), `emojis.ts`, `messageSplitter.ts`.

## How Jules is driven (SDK facts)

Interactive sessions (`requireApproval: true`). States include `queued`, `planning`, `inProgress`,
`awaitingPlanApproval`, `awaitingUserFeedback`, `paused`, `completed`, and `failed` (via `session.info()`).
Relevant activity types include `planGenerated`, `progressUpdated`, `agentMessaged`, `userMessaged`,
`sessionCompleted`, and `sessionFailed`.

JulesBot intentionally **does not** use the SDK's long-lived `session.stream()` watcher. The SDK implements
that abstraction with repeated activity polling, so keeping one stream per old Discord session creates
unbounded background traffic. Instead, `runJulesStream` calls `session.activities.hydrate()` on a schedule,
then reads `session.activities.select({ order: 'asc' })` from the SDK cache. Active work polls quickly; an
agent reply / approval wait / feedback wait / pause / completion moves the watcher to the idle lane, and the
watcher is removed after `jules_polling.idle_timeout_ms` until Discord wakes it again.

Control calls (`session.approve()`, `session.send()`, `session.result()`, session creation, repo listing, and
pre-warming) also share the same request coordinator. `session.stream()` / `session.history()` remain SDK
capabilities but should not be reintroduced into perpetual hot paths without a quota analysis.

**Available but currently unused:** `progressUpdated.artifacts` (code `changeSet` diffs + `media` screenshots),
`session.waitFor(state)`, `session.ask()`. `session.result()` is used on completion to report authoritative
PR metadata and provide a fallback when Jules emits no final `agentMessaged` activity.
Pull current SDK docs from Context7 (`/google-labs-code/jules-sdk`) before changing SDK calls.

## Data model (`prisma/schema.prisma`)

- `GuildConfig(guildId, defaultRepo, forumChannelId, chatChannelId)` — per-server repo plus optional
  forum and normal-text-channel bindings (set via `/link-repo`, `/setup-forum`, `/setup-chat`); YAML
  `guilds:` can override with `forum_channel_id` / `chat_channel_id`.
- `DebugSession(threadId, julesSessionId, statusMessageId, planMessageId, repoName, …)` — the Discord
  thread-or-channel ID ⇄ Jules session map; source of truth for rehydration. The legacy `threadId` column
  also stores configured text-channel IDs.
- `PreWarmedSession(id = julesSessionId, repoName, contextKey, ready, …)` — warm-pool entries.

## Config & personality (`src/config.ts`)

Layered YAML: `templates/config.example.yaml` (defaults) ⊕ root `config.yaml` (gitignored, user). Personality
from `AGENTS.md` / `SOUL.md` (fallback to the templates). `bootstrap/` files (gitignored) are concatenated into
every prompt via `getBootstrapContext()`. **Profiles:** `--profile <name>` / `BOT_PROFILE` isolate `.env`,
`config.yaml`, persona, `bootstrap/`, and `dev.db` under `profiles/<name>/` for running multiple instances.

`config.yaml` is validated before merge. A malformed root, known foreign config keys (for example a LiteLLM
config accidentally written into this path), or a non-empty file with no recognized JulesBot top-level keys
causes startup to fail loudly rather than silently merging template defaults. When adding a new top-level
config key, update `KNOWN_TOP_LEVEL_KEYS` in `src/lib/utils/configValidation.ts` and document it in
`templates/config.example.yaml`.

`jules_polling` is process-global and resolved at boot, not through `getEffectiveConfig()`. Defaults: 5s active
polls, 60s idle polls, 1h idle timeout, concurrency 3, 250ms request spacing, 30s base 429 cooldown, 5m cap.

## User-facing strings (`src/strings.ts`)

**All** user-facing Discord text and the substantive Jules-prompt fragments live in `src/strings.ts` as
`DEFAULT_MESSAGES` (the single source of truth) — **do not hardcode them in other modules.** Add new strings
to the catalog and reference them via `getEffectiveConfig(thread, member).messages.<group>.<key>` (thread
context) or the global `MESSAGES` (no context, e.g. command registration / `index.ts`). Templated strings use
`{placeholder}` tokens filled by `t(template, vars)` (e.g. `t(cfg.messages.session.initializing, { emoji, repo, branch })`).
Every key is overridable via a `messages:` block in `config.yaml`, deep-merged with the same precedence as
everything else (defaults → global → parent channel → tag → thread → role). Only trivial prompt-assembly glue
(`"\n\nUser Issue:\n"` in `JulesClient`/`PreWarmedManager`) stays inline. Tests: `test/strings.test.ts`.

## Conventions

- Match surrounding style: explicit `.js` imports; commands `export default { data, execute }`; events
  `export default { name, execute }`; heavy `[Tag] …` tracing via `logger.debug` (`src/lib/utils/logger.js`,
  level-gated by `LOG_LEVEL`; use `logger.info` for lifecycle, `logger.error/warn` for problems — not raw
  `console.*`); defensive `try/catch` around every Discord/Jules call.
- User-facing strings use the configured `bot_emoji` (default 🐙) and bolded status lines. **Never hardcode
  user-facing text** — it belongs in `src/strings.ts` (see the section above), referenced via `…messages.*` / `t()`.
- Do not bypass the Jules request coordinator. New Jules network calls should go through
  `scheduleJulesRequest()` or the scheduler's `poll()` method so concurrency, pacing, and global 429 backoff
  remain process-wide. Keep Discord hot paths responsive and avoid duplicate SDK network walks (hydrate once,
  then read the local activity cache where possible).
- `ecosystem.config.cjs` intentionally sets PM2 `autorestart: false`. Fatal process errors should remain
  stopped with logs preserved for inspection; deployments/recovery restart the process explicitly.
