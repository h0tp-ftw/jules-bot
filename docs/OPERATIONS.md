# JulesBot Operations Runbook

This runbook covers production deployment, verification, backups, and the failure modes that are easiest to misdiagnose.

## Production assumptions

- Run exactly **one JulesBot process per Discord bot token**. Conversation queues, watcher state, deduplication sets, and the Jules request scheduler are process-local.
- `ecosystem.config.cjs` intentionally sets PM2 `autorestart: false`. A fatal process error should remain stopped with its logs preserved; inspect the cause, then restart explicitly.
- Keep the **same Node major version** for dependency installation, build, and runtime. `better-sqlite3` is a native module, so switching Node ABIs after `npm ci` can produce a `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED` startup error.
- `config.yaml`, `.env`, `AGENTS.md`, `SOUL.md`, `bootstrap/`, and profile runtime files are gitignored. A `git pull` does not restore or update them.

## Before every deployment

Back up the two pieces of runtime state that cannot be reconstructed from Git alone:

```bash
cp config.yaml "config.yaml.backup-$(date -u +%Y%m%dT%H%M%SZ)"
cp prisma/dev.db "prisma/dev.db.backup-$(date -u +%Y%m%dT%H%M%SZ)"
```

If SQLite is actively busy, prefer a proper SQLite backup/snapshot mechanism for production-grade backups. The simple copies above are most useful immediately before a controlled restart when write activity is quiescent.

Check for server-local tracked edits before pulling:

```bash
git status --short --branch
git diff
```

Runtime customization belongs in the gitignored runtime files, not committed templates. Keeping the checkout clean makes `git pull --ff-only` predictable.

## Git-based deployment

From a clean production checkout:

```bash
git fetch origin main
git pull --ff-only origin main
npm ci
npm run build
DATABASE_URL="file:./prisma/dev.db" npx prisma migrate deploy
pm2 restart jules-bot
pm2 save
```

If the host intentionally installs production dependencies only (`npm ci --omit=dev`), do not expect `npm run lint`, `npm test`, or a TypeScript build to work there because ESLint, tsx, and TypeScript are development dependencies. In that model, run build/test/lint in CI and deploy the already-built artifact instead.

If a host has multiple Node installations, verify what PM2 will actually execute:

```bash
node --version
which node
pm2 show jules-bot
```

The PM2 `interpreter` and `node.js version` should match the Node major that owns the installed native dependencies.

## Verify the running build

Do not stop at “PM2 says online.” Confirm all of the following:

```bash
pm2 show jules-bot
pm2 logs jules-bot --lines 200 --nostream
```

Check that:

- `script path` points at this checkout's `dist/index.js`.
- the process start/restart time is **after** the most recent build.
- the expected Node interpreter/version is in use.
- `unstable restarts` is zero.
- `autorestart: false` is still present in the PM2 saved process definition.
- startup logs show the expected guild/forum/chat mappings as `ready`.

For the bounded polling architecture, a built `dist/lib/jules/orchestrator.js` should contain the scheduled-polling path and should not execute an infinite `session.stream()` loop.

## Jules polling lifecycle

All meaningful Jules network traffic shares the process-wide request coordinator.

Default behavior:

- active work: poll every **5 seconds**;
- replied / awaiting input or approval / paused / completed: poll every **60 seconds**;
- after **1 hour idle**: remove the watcher and generate no polling traffic;
- next Discord message/approval: wake or recreate the watcher immediately;
- at most **3** Jules requests run concurrently;
- request starts are spaced by at least **250 ms**;
- the first Jules 429 triggers a shared cooldown starting around **30 seconds** with jitter, growing up to **5 minutes**.

A Jules 429 should therefore appear as a `[JulesPollScheduler]` shared-cooldown warning, not as many independent sessions racing through `Stream Retry …/20`.

## “Bot is online but does not answer”

Work from the routing/config layer outward before assuming Jules itself is broken.

1. Read the current startup lines in the PM2 output log. A guild marked `not ready` is missing a repo and/or forum/chat mapping.
2. Confirm the thread/channel belongs to the configured parent in `config.yaml` or the `GuildConfig` database row.
3. If a **new** forum thread gets no response, verify the forum mapping first; an unconfigured parent is intentionally ignored.
4. If an **existing** mapped thread suddenly returns a permission error, inspect the effective `access_control` settings. The persisted `DebugSession` may still be healthy while the runtime config has fallen back to a closed allowlist.
5. Run `npm run doctor` and inspect the error log before restarting repeatedly.

## Config validation failures

JulesBot intentionally refuses to start when `config.yaml`:

- is not a YAML mapping at the top level;
- contains known configuration keys from another application (for example a LiteLLM config written into the same path); or
- is non-empty but contains no recognized JulesBot top-level settings.

This fail-stop behavior prevents a syntactically valid but unrelated YAML file from silently merging with JulesBot defaults and leaving the bot “online” with broken routing/access behavior.

Restore a known-good `config.yaml`; do **not** delete the file just to bypass validation unless you explicitly want template defaults.

## Rate-limit troubleshooting

When checking whether the scheduler fix is working, compare timestamps rather than grepping the whole retained PM2 log blindly. Old 429 stack traces remain on disk after a successful deployment.

```bash
pm2 show jules-bot
pm2 logs jules-bot --lines 300 --nostream
```

Record the current process start time, then look only for 429s **after** that time. A historical `Stream Retry 20/20` entry from an older process does not mean the current scheduler is still failing.

If 429s continue under the new scheduler, tune the process-global `jules_polling` block in `config.yaml` conservatively: increase `active_interval_ms`, `idle_interval_ms`, `min_request_spacing_ms`, or the rate-limit cooldowns before increasing concurrency.

## Fatal crash / stopped PM2 process

Because automatic restart is disabled, a fatal error is expected to leave JulesBot stopped. This is deliberate.

Inspect first:

```bash
pm2 show jules-bot
pm2 logs jules-bot --lines 300 --nostream
```

After correcting the cause:

```bash
pm2 restart jules-bot
pm2 save
```

Avoid scripted restart loops around PM2; they defeat the fail-stop design and can turn a configuration or native-module error into repeated Discord/Jules connection pressure.
