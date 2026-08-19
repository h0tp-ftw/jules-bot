# Maintainer Tools & Development Commands

This document catalogs the scripts and maintenance helpers that ship with JulesBot. Several are not exposed as `npm run` commands and are easy to miss when browsing only the README.

For production procedures, see [`OPERATIONS.md`](./OPERATIONS.md). For runtime internals, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Supported Node version

`package.json` declares Node `>=20`, but the repository's `.nvmrc`, CI, Docker builder, and Docker runtime all use **Node 22**. Node 22 is therefore the recommended development/production major unless you have a specific reason to use another supported version.

Because `better-sqlite3` is native code, keep the same Node major for dependency installation and runtime.

## Compiler/lint/format policy

`tsconfig.json` targets ES2022, uses Node16 ESM/module resolution, enables strict TypeScript, and emits `src/**/*` to `dist/`. Relative TypeScript imports therefore use explicit `.js` extensions so the compiled ESM paths work under Node.

ESLint uses flat config with the recommended JavaScript/TypeScript rules plus `eslint-config-prettier`. It intentionally allows explicit `any` in this dynamic Discord/YAML-heavy codebase and treats unused variables as warnings (with `_`-prefixed intentional variables ignored).

Prettier owns formatting: no semicolons, single quotes, 100-character print width, trailing commas. The configured formatter script targets JavaScript/TypeScript source/scripts/tests plus `eslint.config.js`; Markdown/YAML documentation is not part of that npm formatting command. `dist`, dependency trees, lockfile, migrations, and databases are excluded by the committed ignore files.

## Package scripts

### `npm run setup`

Runs `scripts/setup.js`, the interactive first-run wizard.

Interactive behavior:

1. checks the Node major;
2. optionally rewrites `.env` after confirmation;
3. validates the Discord token against `/users/@me` and prints an invite URL;
4. copies missing `config.yaml`, `AGENTS.md`, and `SOUL.md` templates;
5. installs dependencies if `node_modules` is missing;
6. validates the Jules API key by listing connected repositories when the SDK is available;
7. runs `prisma generate` and `prisma migrate deploy`;
8. optionally starts source or production mode.

Existing runtime config/persona files are left untouched by the template-copy step.

The setup wizard is root-install oriented: it writes root `.env` / runtime files and does not implement `BOT_PROFILE` / `--profile` setup semantics. Profile directories are created/layered by `src/config.ts` when the application itself starts with a profile.

#### Non-interactive setup

A non-TTY invocation **without** `--yes` only creates/copies configuration files; it intentionally does not perform a surprise dependency install.

`--yes` / `-y` additionally installs missing dependencies and provisions Prisma:

```bash
DISCORD_TOKEN="..." JULES_API_KEY="..." npm run setup -- --yes
```

### `npm run doctor`

Runs `scripts/doctor.js`.

It checks:

- Node major;
- presence of `.env` and `config.yaml`;
- whether required credential environment values are non-placeholder;
- SQLite file presence (missing is only a warning because first boot can provision it);
- presence of a generated Prisma client.

It is intentionally a lightweight pre-flight and **does not** currently:

- parse/validate `config.yaml` with JulesBot's runtime validator;
- contact Discord;
- contact Jules;
- verify guild/forum/channel mappings;
- verify PM2/Docker state.

A passing doctor result means the basic local prerequisites are present, not that every remote dependency is healthy.

`doctor.js` is also root-install oriented. It loads/checks root `.env`, `config.yaml`, and the resolved/default root `DATABASE_URL`; it does not implement the application's profile bootstrap/config resolution. For a profile deployment, verify the profile files/database directly in addition to running doctor.

### `npm run dev`

Runs:

```text
prisma generate && LOG_LEVEL=debug tsx src/index.ts
```

This executes TypeScript source directly and forces debug logging. It is **not a file watcher/hot-reload command**; restart it after source edits.

On Windows shells that do not support POSIX-style inline environment assignment, invoke with a compatible shell or set `LOG_LEVEL=debug` separately.

### `npm run build`

Runs `tsc` and writes compiled ESM JavaScript to `dist/`. This is also the project's strict TypeScript typecheck.

### `npm start`

Runs the previously built application:

```text
node dist/index.js
```

It does not build first.

### `npm run lint`

Runs ESLint over the repository.

### `npm run format`

Runs Prettier with `--write` over TypeScript/JavaScript source, scripts, tests, and `eslint.config.js`.

### `npm run format:check`

Checks the same Prettier surface without modifying files. CI runs this.

### `npm test`

Runs the explicit Node test list through `tsx`. The suite currently covers:

- activity polling/scheduler behavior;
- attachment formatting;
- channel routing;
- configuration precedence;
- config validation;
- conversation queue/nudge behavior;
- emoji resolution;
- error formatting;
- invite permissions;
- logger behavior;
- message splitting;
- access control;
- reaction markers;
- session outcome/state helpers;
- `StreamManager` overflow behavior;
- string/template merging.

There is no full Discord ↔ Jules integration test harness.

### `npm run db:generate`

Runs `prisma generate`.

### `npm run db:migrate`

Runs `prisma migrate dev`. Use this when intentionally changing `prisma/schema.prisma` during development; production deployment should apply committed migrations with `prisma migrate deploy`.

## Standalone diagnostic scripts

These scripts are committed but are not currently package.json shortcuts.

### `scripts/check-sessions.ts`

Run with:

```bash
npx tsx scripts/check-sessions.ts
```

Prints the 10 most recently **created** `DebugSession` rows with Discord thread/channel ID, repo, Jules session ID, and creation time.

Important limitations:

- the script is hard-coded to `file:./prisma/dev.db`;
- it does not honor `DATABASE_URL`;
- it does not honor `BOT_PROFILE` / `--profile`;
- it does not contact Jules.

Do not assume its output represents a profile or Docker database unless you intentionally run it against a matching checkout/data layout.

### `scripts/check-session-status.ts`

Run with:

```bash
npx tsx scripts/check-session-status.ts
```

Loads the five most recently created local `DebugSession` rows and calls Jules `session.info()` for each one.

Important limitations/warnings:

- database path is hard-coded to `file:./prisma/dev.db`;
- profile/Docker databases are not selected automatically;
- it reads `JULES_API_KEY` from the environment/root dotenv setup;
- it runs as a **separate process**, so its Jules calls do not share the live bot's `JulesRequestCoordinator` cooldown/concurrency state;
- repeatedly looping this script during a Jules rate-limit incident can add more API traffic.

Use it deliberately, not as a high-frequency monitor.

## Bootstrap generator

### `scripts/generate_bootstrap.js`

This is a project-specific helper, **not a generic JulesBot setup command**.

It is currently hard-coded to repository `h0tp-ftw/ankimon` and uses the GitHub CLI (`gh`) to fetch:

- latest release information;
- merged PRs since the latest release;
- open PRs;
- open issues.

It substitutes that information into `templates/soul_template.md` and writes `bootstrap/010_soul.md`.

### Destructive behavior

Before generating, it deletes **every `.md` file directly inside `bootstrap/`**.

That means you should not run it casually on a bootstrap directory containing hand-written Markdown you have not backed up.

Requirements:

- `gh` installed;
- `gh` authenticated with access to the referenced GitHub repository;
- network access;
- `templates/soul_template.md` present.

The helper does not currently accept a repository argument and does not understand JulesBot profiles. If you need generic/profile-aware bootstrap generation, change the script rather than assuming this one is portable.

## Health probe helper

### `scripts/healthcheck.js`

This is the Docker/container probe, not the health server itself.

It makes an HTTP request to:

```text
http://127.0.0.1:${HEALTHCHECK_PORT:-3000}/health
```

and exits zero only for HTTP 200.

The actual endpoint is served by `src/lib/health.ts` when `HEALTHCHECK_PORT` is set. Health is 200 only when:

- Discord.js reports the gateway ready; and
- SQLite answers `SELECT 1`.

Otherwise it returns 503 with a small JSON body describing gateway/database state.

## Prisma/database tooling

Prisma 7 reads its datasource URL from `prisma.config.ts` rather than a `url` field in `schema.prisma`.

Default:

```text
DATABASE_URL=file:./prisma/dev.db
```

Useful commands:

```bash
npx prisma generate
DATABASE_URL="file:./prisma/dev.db" npx prisma migrate deploy
npm run db:migrate
```

On first boot, if a SQLite file is missing, `src/config.ts` attempts `prisma migrate deploy` automatically and falls back to `prisma db push` if migration deployment is unavailable.

The committed migration history currently covers:

- initial guild/session schema;
- forum channel binding;
- pre-warmed sessions and readiness/context fields;
- persisted activity-delivery cursor;
- shared chatbot channel binding.

## Docker tooling

`Dockerfile` uses Node 22 for both builder and runtime stages. The builder installs a C/C++ toolchain so `better-sqlite3` can be built, while the runtime image receives the built `node_modules` without the compiler toolchain.

`.dockerignore` deliberately excludes:

- secrets/runtime config (`.env`, `config.yaml`, `AGENTS.md`, `SOUL.md`);
- `bootstrap/` and profiles;
- local databases/data;
- tests/scratch files;
- local build artifacts.

`docker-compose.yml`:

- persists SQLite in `./data`;
- forces `DATABASE_URL=file:/app/data/dev.db`;
- enables `HEALTHCHECK_PORT=3000` internally;
- uses the Node healthcheck helper;
- optionally bind-mounts runtime config/persona files when you uncomment those entries.

### Docker restart policy differs from PM2

The shipped Compose file currently uses:

```yaml
restart: unless-stopped
```

So Docker **will restart the container after a fatal process exit**. This is different from `ecosystem.config.cjs`, which deliberately uses PM2 `autorestart: false` for fail-stopped crash inspection.

Choose the process-manager behavior intentionally for your deployment rather than assuming PM2 and Docker have the same restart semantics.

## PM2 configuration

`ecosystem.config.cjs` pins:

- one fork-mode instance;
- `autorestart: false`;
- timestamps and merged logs;
- 5-second graceful-kill timeout;
- `NODE_ENV=production`.

Because the bot has important process-local coordination state, do not turn this into PM2 cluster mode or multiple instances for one Discord token.

## GitHub CI

`.github/workflows/ci.yml` runs on pushes and pull requests to `main` using Node 22:

1. `npm ci`;
2. `npx prisma generate`;
3. `npm run build`;
4. `npm run lint`;
5. `npm run format:check`;
6. `npm test`.

CI sets `DATABASE_URL=file:./prisma/dev.db` because Prisma configuration/code generation expects a datasource even though the unit tests do not need a real application database.

## Dependabot

`.github/dependabot.yml` checks weekly for:

- npm dependency updates (minor/patch updates grouped to reduce PR noise);
- GitHub Actions updates.

The npm Dependabot open-PR limit is 5.

## Invite-link helper

`scripts/lib/invite.js` builds the OAuth2 bot invite URL used by setup and unit tests.

The encoded Discord permissions are:

- Add Reactions;
- View Channels;
- Send Messages;
- Manage Messages;
- Embed Links;
- Read Message History;
- Use Application Commands;
- Send Messages in Threads.

If runtime functionality starts requiring an additional permission, update both this helper and the README/security documentation together.

## Runtime logs

All application logging should use `src/lib/utils/logger.ts` rather than raw `console.*` in runtime code. Log threshold comes from `LOG_LEVEL` and is read dynamically.

PM2 retains old log lines across restarts, so incident analysis must correlate error timestamps with the current process start time. See [`OPERATIONS.md`](./OPERATIONS.md).

## Scratch/local-only files

The repository's `.gitignore` excludes `scratch/`, local `.jules` state, runtime config/persona files, profiles, bootstrap data, databases, logs, and similar developer artifacts. Do not use a local scratch file as canonical documentation or production configuration.
