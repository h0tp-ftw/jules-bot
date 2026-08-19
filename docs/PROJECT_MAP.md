# JulesBot Repository Map

This is a file-oriented map of the JulesBot repository. Use it when you know *what kind of thing* you are looking for but not which module owns it.

For behavioral detail, follow the linked focused guides rather than treating this map as the full specification.

## Top-level application files

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Process entry point: Discord client/intents, command registration, event wiring, startup readiness logs, presence, DB pragmas, health server, Discord login retry, graceful shutdown |
| `src/config.ts` | Loads root/profile env and YAML, validates config, resolves profiles/database paths/personas/bootstrap, creates Prisma client, exposes `getEffectiveConfig()` |
| `src/strings.ts` | Canonical user-facing Discord copy and reusable Jules prompt fragments; deep override/template helpers |
| `package.json` | npm scripts, runtime/dev dependencies, Node engine requirement |
| `package-lock.json` | Reproducible npm dependency lockfile |
| `tsconfig.json` | Strict TypeScript/Node16 ESM compiler settings and `dist/` output |
| `prisma.config.ts` | Prisma 7 datasource URL (`DATABASE_URL`) |

## Discord commands

| Path | Purpose |
| --- | --- |
| `src/commands/link-repo.ts` | `/link-repo owner/repo`; stores the guild default repository in SQLite |
| `src/commands/setup-forum.ts` | `/setup-forum`; stores one guild forum binding in SQLite |
| `src/commands/setup-chat.ts` | `/setup-chat`; stores one guild shared-text-channel binding in SQLite |
| `src/commands/approve.ts` | `/approve`; verifies current Jules state and approves a pending plan |

The setup/link commands declare Discord `Manage Server` as their default member permission. All slash commands also pass through JulesBot's own `access_control` gate in `src/index.ts`.

## Discord events

| Path | Purpose |
| --- | --- |
| `src/events/threadCreate.ts` | Detects configured forum posts, fetches starter message, resolves repo/branch, exposes interactive selection, initializes forum sessions |
| `src/events/messageCreate.ts` | Routes forum/chat messages, attachments, permissions, queueing, wake-on-demand, sends follow-ups into existing sessions |
| `src/events/interactionCreate.ts` | Handles plan buttons, repo/branch menus, branch search and custom-branch modals |

## Jules/session core

| Path | Purpose |
| --- | --- |
| `src/lib/jules/orchestrator.ts` | Main Jules↔Discord lifecycle: session initialization, activity delivery, plans, progress, replies, reactions, nudge scheduling, completion fallback, persisted delivery cursor, startup rehydration |
| `src/lib/jules/JulesClient.ts` | Shared Jules SDK client, session prompt assembly, session create/get, 30-second connected-repo cache |
| `src/lib/jules/JulesRequestCoordinator.ts` | Singleton process-wide coordinator used for Jules SDK operation entry points |
| `src/lib/jules/ActivityPollScheduler.ts` | Active/idle poll timing, watcher expiry, operation concurrency/spacing, global 429 cooldown |
| `src/lib/jules/ConversationQueue.ts` | Per-Discord-conversation in-memory turn serialization and one-shot nudge timers |
| `src/lib/jules/PreWarmedManager.ts` | Creates, stores, validates, consumes/replenishes context-specific pre-warmed Jules sessions |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the lifecycle and [`CONFIGURATION.md`](./CONFIGURATION.md) for scheduler/warm-pool settings.

## Discord presentation/state helpers

| Path | Purpose |
| --- | --- |
| `src/lib/streams/StreamManager.ts` | Reusable forum progress/status message, 3-second debounce, last-15 progress buffer, long-message overflow replies, final status |
| `src/lib/health.ts` | Optional unauthenticated `GET /health` readiness server for gateway + SQLite state |

## Utility modules

| Path | Purpose |
| --- | --- |
| `src/lib/utils/attachments.ts` | Converts Discord attachment metadata into the prompt block sent to Jules |
| `src/lib/utils/channelRouting.ts` | Decides whether a forum thread parent is configured (guild forum ID or `channels:` parent key) |
| `src/lib/utils/configValidation.ts` | Fail-stop validation of the runtime YAML top level and recognized config keys |
| `src/lib/utils/emojis.ts` | Remaps custom emoji tags/shortcodes in agent text against the bot's current Discord emoji cache |
| `src/lib/utils/errors.ts` | Converts thrown values to Discord-safe, bounded fenced-code text and neutralizes embedded backtick runs |
| `src/lib/utils/logger.ts` | ISO-timestamped, level-gated logger controlled by `LOG_LEVEL` |
| `src/lib/utils/messageSplitter.ts` | Splits Discord text at newline boundaries where possible, hard-splitting when necessary |
| `src/lib/utils/permissions.ts` | Access-control evaluation, creator ownership, user/role allowlists, `silent` result |
| `src/lib/utils/reactionMarkers.ts` | Parses/removes Jules `[[react:EMOJI]]` protocol markers |
| `src/lib/utils/sessionOutcome.ts` | Tracks whether a Discord-originated turn received a Jules reply and builds truthful completion fallbacks |
| `src/lib/utils/sessionState.ts` | Pure Jules-state → lifecycle-reaction-stage mapping |

### Custom emoji remapping

When Jules returns text containing a full custom emoji tag such as `<:party:OLD_ID>` or an available `:party:` shortcode, `resolveMessageEmojis()` looks for a cached emoji with the same name and rewrites it to the ID visible to the current bot. If no matching cached custom emoji exists, the original text is left unchanged. The same resolver is used when applying Jules-authored reaction markers.

### Error formatting

`formatErrorForDiscord()` prefers an Error stack, falls back to its message/string form, breaks up backtick runs so an exception cannot escape the surrounding Markdown fence, trims the result, and caps it (default 1800 chars) to leave room under Discord's 2000-character message limit.

## Database

| Path | Purpose |
| --- | --- |
| `prisma/schema.prisma` | Models `GuildConfig`, `DebugSession`, and `PreWarmedSession` |
| `prisma/migrations/*` | Committed migration history applied in production |
| `prisma/migrations/migration_lock.toml` | Prisma migration provider lock |

Migration sequence currently records:

1. initial guild/session schema;
2. forum channel binding;
3. pre-warmed session table;
4. pre-warmed ready flag;
5. pre-warmed welcome-message field;
6. pre-warmed context key;
7. persisted Jules activity-delivery cursor;
8. shared chatbot channel binding.

Runtime databases (`prisma/dev.db`, profile DBs, Docker `./data`) are gitignored.

## Runtime/setup scripts

| Path | Purpose |
| --- | --- |
| `scripts/setup.js` | Interactive/non-interactive first-run setup, credential checks, template copies, dependency/Prisma setup |
| `scripts/doctor.js` | Lightweight local prerequisite checker (not a network/runtime health test) |
| `scripts/check-sessions.ts` | Prints recent rows from hard-coded root `prisma/dev.db` |
| `scripts/check-session-status.ts` | Uses root DB + Jules API to inspect a few recent session states; separate from live coordinator |
| `scripts/generate_bootstrap.js` | Ankimon-specific `gh`-driven bootstrap generator; deletes root `bootstrap/*.md` before generating |
| `scripts/healthcheck.js` | Container probe client for the in-process `/health` server |
| `scripts/lib/invite.js` | Builds Discord OAuth2 invite URL and permission bitfield |

The exact behavior and warnings for these tools are in [`MAINTAINER_TOOLS.md`](./MAINTAINER_TOOLS.md).

## Runtime templates

| Path | Purpose |
| --- | --- |
| `templates/.env.example` | Environment variable starter/reference |
| `templates/config.example.yaml` | Committed runtime YAML defaults plus annotated examples |
| `templates/AGENTS.example.md` | Default/fallback agent personality template |
| `templates/SOUL.example.md` | Default/fallback soul/principles template |
| `templates/soul_template.md` | Input template used by the Ankimon-specific `generate_bootstrap.js` helper |

Root `.env`, `config.yaml`, `AGENTS.md`, `SOUL.md`, `bootstrap/`, and `profiles/` are runtime state and are intentionally gitignored.

## Deployment/container files

| Path | Purpose |
| --- | --- |
| `ecosystem.config.cjs` | PM2 single-process production definition; fail-stopped `autorestart: false` |
| `Dockerfile` | Node 22 multi-stage image; builds native `better-sqlite3` in builder stage |
| `docker-compose.yml` | Single container, persisted `./data`, healthcheck, `restart: unless-stopped`, optional runtime config/persona mounts |
| `.dockerignore` | Keeps secrets, runtime state, local DBs, tests/scratch, profiles/bootstrap, and local build output out of image context |

PM2 and Docker deliberately have different restart behavior; see [`OPERATIONS.md`](./OPERATIONS.md).

## Development/tool configuration

| Path | Purpose |
| --- | --- |
| `.nvmrc` | Recommended Node major (`22`) |
| `eslint.config.js` | ESLint configuration |
| `.prettierrc.json` | Prettier formatting rules |
| `.prettierignore` | Formatting exclusions (`dist`, `node_modules`, lockfile, migrations, DBs) |
| `.gitignore` | Excludes secrets, runtime personas/config, databases, profiles, bootstrap/scratch and generated/local state |

## GitHub automation

| Path | Purpose |
| --- | --- |
| `.github/workflows/ci.yml` | Node 22 CI: install, Prisma generate, build, lint, Prettier check, tests |
| `.github/dependabot.yml` | Weekly npm and GitHub Actions dependency update checks |

## Documentation/governance

| Path | Purpose |
| --- | --- |
| `README.md` | User-facing project overview, setup, key features, commands, deployment entry point |
| `docs/CONFIGURATION.md` | Complete runtime settings, profiles, precedence, access-control behavior |
| `docs/ARCHITECTURE.md` | Runtime/session/queue/scheduler/recovery/data-flow reference |
| `docs/OPERATIONS.md` | Production deployment, verification, backup and incident runbook |
| `docs/MAINTAINER_TOOLS.md` | Script/dev/CI/Docker/Prisma helper reference |
| `docs/PROJECT_MAP.md` | This file-oriented repository inventory |
| `CONTRIBUTING.md` | Contributor verification/conventions/commit guidance |
| `SECURITY.md` | Vulnerability reporting and runtime-data/security notes |
| `CLAUDE.md` | Repository-specific instructions and landmines for coding agents/maintainers |
| `LICENSE` | MIT license |

## Tests

`test/_ensureDb.ts` prepares an empty SQLite file before config-importing unit tests so importing `src/config.ts` does not trigger application DB provisioning during those tests.

| Test | Main behavior covered |
| --- | --- |
| `activityPollScheduler.test.ts` | active/idle expiry, global 429 retry, spacing, concurrency |
| `attachments.test.ts` | attachment prompt metadata formatting |
| `channelRouting.test.ts` | configured forum parent routing |
| `config.test.ts` | effective config precedence and defaults |
| `configValidation.test.ts` | fail-stop YAML top-level validation |
| `conversationQueue.test.ts` | serialized turns, queue state, nudge behavior |
| `emojis.test.ts` | custom emoji remapping |
| `errors.test.ts` | Discord-safe error formatting |
| `invite.test.ts` | OAuth2 scopes/permission bitfield |
| `logger.test.ts` | log levels, timestamps, dynamic threshold |
| `messageSplitter.test.ts` | message splitting and no-data-loss behavior |
| `permissions.test.ts` | access control and normal-text current-speaker role behavior |
| `reactionMarkers.test.ts` | Jules reaction marker parsing |
| `sessionOutcome.test.ts` | reply tracking and completion fallback wording |
| `sessionState.test.ts` | Jules state → reaction stage mapping |
| `streamManager.test.ts` | reusable long status/overflow messages |
| `strings.test.ts` | string templating/deep message override behavior |

There is currently no full integration test that creates a real Discord thread and real Jules session end-to-end.
