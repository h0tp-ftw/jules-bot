# CLAUDE.md

Guidance for AI coding agents working on **JulesBot**. Keep this current as the code changes.

## What this is

JulesBot is a Discord bot that turns each **forum thread** into an interactive **Google Jules**
coding-agent session. It streams Jules's live activity into a Discord thread and gates any proposed
plan behind **Approve / Reject** buttons — "diagnose first, change only on human approval."

Stack: **TypeScript (ESM) · discord.js v14 · @google/jules-sdk · Prisma v7 + SQLite (better-sqlite3)**.

## Commands

- `npm run dev` — run from source via tsx (`prisma generate && tsx src/index.ts`). Primary dev loop.
- `npm run build` — `tsc` → `dist/`. **Use this to typecheck** (strict mode is on).
- `npm run start` — run compiled output (`node dist/index.js`). Production (`pm2` is a dependency).
- `npm run setup` — copy `templates/*` → root runtime files (`.env`, `config.yaml`, `AGENTS.md`, `SOUL.md`). Skips files that already exist.
- `npm run db:migrate` — `prisma migrate dev` (run after editing `prisma/schema.prisma`).
- `npm run db:generate` — regenerate the Prisma client.
- `npm test` — `node:test` unit suite over the pure utils + `strings.ts` (`test/*.test.ts`, DB-free). No
  integration coverage of the Discord/Jules round-trip, so also verify with `npm run build` + a manual `npm run dev`.
- CI (`.github/workflows/ci.yml`) runs `npm run build` + `npm test` on every push/PR to `main`.

Required env (`.env`): `DISCORD_TOKEN`, `JULES_API_KEY`, `DATABASE_URL` (defaults to `file:./prisma/dev.db`).
If the SQLite file is missing, `src/config.ts` auto-provisions it via `npx prisma db push` on boot.

## ⚠️ Repo-specific landmines

1. **ESM with explicit `.js` import extensions.** `tsconfig` uses `module`/`moduleResolution: Node16`
   and the package is `"type": "module"`. Every relative import must end in `.js` even though the file
   is `.ts` — e.g. `import { prisma } from '../config.js'`. Omitting it breaks build/runtime. Match the existing style.
2. **`AGENTS.md` and `SOUL.md` are runtime config, not docs.** They are **gitignored** and read by
   `src/config.ts` into `AGENT_PERSONALITY` / `SOUL_PERSONALITY`, then injected into *every* Jules session
   prompt (`src/lib/jules/JulesClient.ts`). Do **not** put codebase/agent docs there — that's why this file
   is `CLAUDE.md`. Edit the committed persona defaults in `templates/AGENTS.example.md` / `templates/SOUL.example.md`.
3. **Resolve per-thread settings through `getEffectiveConfig(thread?, member?)`** (`src/config.ts`).
   Precedence: global YAML → parent-channel override → thread override → role override. Don't read
   `yamlConfig.*` directly when behavior should vary by channel/role.
4. **Module-level state is process-local and lost on restart.** `activeStreams`, `autoRejectedSessions`,
   `processedActivityIdsMap` (orchestrator) and `StreamManager`'s buffers/timers do not survive a restart.
   Persisted truth lives in SQLite (`DebugSession`); on boot `rehydrateActiveStreams()` re-attaches streams
   for sessions touched in the last 7 days. Anything new you add to module state must tolerate restarts / serverless pauses.
5. **Discord 2000-char limit.** Use `splitMessage()` (`src/lib/utils/messageSplitter.ts`) for agent output;
   status-message edits are sliced to ~1990 chars.
6. **Prisma uses a driver adapter.** `prisma/schema.prisma`'s `datasource` has **no `url`** — it comes from
   `prisma.config.ts` / `DATABASE_URL` plus the `@prisma/adapter-better-sqlite3` adapter in `src/config.ts`.
   Export `DATABASE_URL` when running raw `prisma` CLI commands.

## Architecture / request flow

Forum thread created → Jules session → live stream into Discord → human gates the plan.

```
ThreadCreate ─▶ (optional repo/branch select) ─▶ initializeJulesSession ─▶ JulesClient.createSession
                                                        │                          │
MessageCreate ─▶ session.send(prompt + metadata)        ▼                          ▼
InteractionCreate (buttons/menus/modals) ───────▶ runJulesStream  ◀── jules-sdk session.stream()
                                                        │
                          StreamManager (status msg) · reactions · Approve/Reject plan embeds
```

Key modules:

- `src/index.ts` — client bootstrap, intents (Guilds, GuildMessages, **MessageContent**), event wiring,
  global slash-command registration on ready, `initPreWarmedPools()` + `rehydrateActiveStreams()`, presence.
  Has process-level `unhandledRejection` / `uncaughtException` guards.
- `src/events/threadCreate.ts` — gate on the configured forum channel; optional interactive repo/branch
  pickers; otherwise `initializeJulesSession`.
- `src/events/messageCreate.ts` — forward user messages to the mapped session (with a metadata header),
  rehydrate the stream if inactive, honor `ignore_prefix`.
- `src/events/interactionCreate.ts` — buttons (`plan-approve` / `plan-reject`), select menus
  (`select-repo` / `select-branch`), and branch search/custom modals. Note the Discord **25-option** menu cap handled here.
- `src/lib/jules/orchestrator.ts` — **core.** `runJulesStream` (dedup via `processedActivityIds`, reconnect
  up to 20×, typing indicators, reactions, plan embeds, auto-reject), `initializeJulesSession` (creation +
  pre-warmed consumption + welcome-plan handling), `rehydrateActiveStreams`.
- `src/lib/jules/JulesClient.ts` — thin `@google/jules-sdk` wrapper. Builds the full prompt =
  `diagnostic_prompt` + persona + soul + bootstrap + user issue. `createSession` / `getSession` / `getConnectedRepos`.
- `src/lib/jules/PreWarmedManager.ts` — pre-warmed session pools to hide clone/queue latency
  (`preWarmSession`, `replenishPool`, `initPreWarmedPools` — which on startup removes only **orphaned
  still-warming** sessions and **preserves `ready` ones** across restarts, then tops the pool back up).
- `src/lib/streams/StreamManager.ts` — one editable "status message" per thread; buffers progress lines,
  debounced 3s flush, `finalizeSession`.
- `src/lib/utils/` — `permissions.ts` (allowlist + thread-creator context), `emojis.ts`, `messageSplitter.ts`.

## How Jules is driven (SDK facts)

Interactive sessions (`requireApproval: true`). States: `queued → planning → inProgress →
awaitingPlanApproval → completed / failed` (via `session.info()`). Activities from `session.stream()`:
`planGenerated`, `progressUpdated`, `agentMessaged`, `userMessaged`, `sessionCompleted`, `sessionFailed`.
Control: `session.approve()`, `session.send()`; replay with `session.history()`; list repos with `jules.sources()`.

**Available but currently unused:** `progressUpdated.artifacts` (code `changeSet` diffs + `media` screenshots),
`session.waitFor(state)`, `session.ask()`, `session.result()` (final state + PR URL).
Pull current SDK docs from Context7 (`/google-labs-code/jules-sdk`) before changing SDK calls.

## Data model (`prisma/schema.prisma`)

- `GuildConfig(guildId, defaultRepo, forumChannelId)` — per-server repo + forum binding (set via
  `/link-repo`, `/setup-forum`); YAML `guilds:` can override.
- `DebugSession(threadId, julesSessionId, statusMessageId, planMessageId, repoName, …)` — the thread⇄session
  map; source of truth for rehydration.
- `PreWarmedSession(id = julesSessionId, repoName, contextKey, ready, …)` — warm-pool entries.

## Config & personality (`src/config.ts`)

Layered YAML: `templates/config.example.yaml` (defaults) ⊕ root `config.yaml` (gitignored, user). Personality
from `AGENTS.md` / `SOUL.md` (fallback to the templates). `bootstrap/` files (gitignored) are concatenated into
every prompt via `getBootstrapContext()`. **Profiles:** `--profile <name>` / `BOT_PROFILE` isolate `.env`,
`config.yaml`, persona, `bootstrap/`, and `dev.db` under `profiles/<name>/` for running multiple instances.

## User-facing strings (`src/strings.ts`)

**All** user-facing Discord text and the substantive Jules-prompt fragments live in `src/strings.ts` as
`DEFAULT_MESSAGES` (the single source of truth) — **do not hardcode them in other modules.** Add new strings
to the catalog and reference them via `getEffectiveConfig(thread, member).messages.<group>.<key>` (thread
context) or the global `MESSAGES` (no context, e.g. command registration / `index.ts`). Templated strings use
`{placeholder}` tokens filled by `t(template, vars)` (e.g. `t(cfg.messages.session.initializing, { emoji, repo, branch })`).
Every key is overridable via a `messages:` block in `config.yaml`, deep-merged with the same precedence as
everything else (defaults → global → parent channel → thread → role). Only trivial prompt-assembly glue
(`"\n\nUser Issue:\n"` in `JulesClient`/`PreWarmedManager`) stays inline. Tests: `test/strings.test.ts`.

## Conventions

- Match surrounding style: explicit `.js` imports; commands `export default { data, execute }`; events
  `export default { name, execute }`; heavy `[Tag] …` tracing via `logger.debug` (`src/lib/utils/logger.js`,
  level-gated by `LOG_LEVEL`; use `logger.info` for lifecycle, `logger.error/warn` for problems — not raw
  `console.*`); defensive `try/catch` around every Discord/Jules call.
- User-facing strings use the configured `bot_emoji` (default 🐙) and bolded status lines. **Never hardcode
  user-facing text** — it belongs in `src/strings.ts` (see the section above), referenced via `…messages.*` / `t()`.
- Recent work (see git log) focused on **removing blocking network calls from hot paths** — avoid adding
  awaited network round-trips inside the `runJulesStream` loop or `messageCreate`.
