# Contributing to JulesBot

Thanks for your interest in improving JulesBot! This guide covers local setup
and the conventions the codebase follows.

## Local setup

```bash
npm install
npm run setup        # copies templates/* -> .env, config.yaml, AGENTS.md, SOUL.md
```

Fill in `DISCORD_TOKEN` and `JULES_API_KEY` in `.env`, then:

```bash
npm run dev          # prisma generate + tsx src/index.ts (hot dev loop)
```

## Verifying changes

There is no integration test harness for the Discord/Jules round-trip, so verify
with:

```bash
npm run build        # tsc, strict mode — this is the typecheck
npm run lint         # ESLint
npm run format:check # Prettier (run `npm run format` to auto-fix)
npm test             # node:test unit suite (pure utils + strings)
```

All four run in CI on every PR. Please make sure they pass locally first, and do
a manual `npm run dev` smoke test for behavior changes. Polling/rate-limit changes
should also add or update `test/activityPollScheduler.test.ts` so idle expiry,
request pacing, concurrency, and shared 429 behavior stay deterministic.

## Conventions

- **ESM with explicit `.js` import extensions.** Every relative import must end
  in `.js`, even though the source is `.ts` (e.g. `import { prisma } from '../config.js'`).
  This is required by the `Node16` module resolution; omitting it breaks the build.
- **No hardcoded user-facing strings.** All Discord-facing text (and the
  substantive Jules-prompt fragments) lives in `src/strings.ts` as
  `DEFAULT_MESSAGES`, and must stay overridable via the `messages:` block in
  `config.yaml`. Reference strings through `getEffectiveConfig(...).messages.*`
  (with thread context) or the global `MESSAGES`.
- **Resolve per-thread settings via `getEffectiveConfig(thread?, member?)`.**
  Don't read `yamlConfig.*` directly when behavior should vary by channel/tag/role.
  Precedence: defaults → global YAML → parent channel → tag → thread → role.
- **Route Jules network calls through the shared coordinator.** Use
  `scheduleJulesRequest()` for one-off SDK requests and the `ActivityPollScheduler`
  polling path for watcher activity. Do not reintroduce a permanent `session.stream()`
  per Discord session or bypass the global concurrency/429 budget.
- **Keep hot paths responsive.** Avoid duplicate network walks: prefer one
  `session.activities.hydrate()` followed by local cache reads when possible.
- **Defensive `try/catch`** around Discord/Jules boundaries, using the level-gated
  `logger` (`debug`/`info`/`warn`/`error`) rather than raw `console.*` calls.
- **Runtime config files are gitignored.** Edit the committed defaults in
  `templates/*.example.*`, not the local runtime copies. When adding a new top-level
  YAML key, also add it to `src/lib/utils/configValidation.ts`; otherwise a config
  containing only that new key can be rejected as unrecognized.

`CLAUDE.md` has a deeper architecture tour and a list of repo-specific landmines
worth skimming before larger changes.

## Commit & PR style

- Use [Conventional Commits](https://www.conventionalcommits.org/)
  (`fix:`, `feat:`, `chore:`, `docs:`, `refactor:`, `perf:`, `ci:`).
- Keep PRs focused; fill out the PR template checklist.
