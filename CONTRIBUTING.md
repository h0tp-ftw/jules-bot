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
a manual `npm run dev` smoke test for behavior changes.

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
  Don't read `yamlConfig.*` directly when behavior should vary by channel/role.
  Precedence: defaults → global YAML → parent channel → thread → role.
- **Keep hot paths non-blocking.** Avoid adding awaited network round-trips
  inside the `runJulesStream` loop or `messageCreate`.
- **Defensive `try/catch`** around every Discord/Jules API call, with
  `console.log('[Tag] …')` tracing to match the surrounding style.
- **Runtime config files are gitignored.** Edit the committed defaults in
  `templates/*.example.*`, not the local runtime copies.

`CLAUDE.md` has a deeper architecture tour and a list of repo-specific landmines
worth skimming before larger changes.

## Commit & PR style

- Use [Conventional Commits](https://www.conventionalcommits.org/)
  (`fix:`, `feat:`, `chore:`, `docs:`, `refactor:`, `perf:`, `ci:`).
- Keep PRs focused; fill out the PR template checklist.
