# Agent Guidelines for JulesBot

Repository guidelines for AI coding assistants (Claude, Antigravity, Copilot, Cursor) working directly on the **JulesBot** codebase.

---

## 1. Project Purpose & Architecture

JulesBot is a Discord bot that turns Discord forum threads into interactive **Google Jules** coding-agent sessions and enables text-channel conversational chatbot mode.

* **Stack**: TypeScript (ESM) · Node.js (Node 20+) · discord.js v14 · `@google/jules-sdk` · Prisma v7 + SQLite (`@prisma/adapter-better-sqlite3`).
* **Session Lifecycle**: Discord interaction/thread creation ➔ `initializeJulesSession` ➔ `JulesClient.createSession` (with diagnostic instructions + persona prompts) ➔ `runJulesStream` background polling loop ➔ `StreamManager` live Discord status updates.

---

## 2. Directory Layout & Key Locations

* **`src/`**: Bot application code.
  * **`src/commands/`**: Slash commands (`/link-repo`, `/new`, `/setup-forum`, `/setup-chat`, `/approve`).
  * **`src/events/`**: Discord event handlers (`threadCreate.ts`, `messageCreate.ts`, `interactionCreate.ts`, and interaction handlers).
  * **`src/lib/jules/`**: Jules integration layer (`JulesClient.ts`, `orchestrator.ts`, `runJulesStream.ts`, `sessionInit.ts`, `nudges.ts`, `reactions.ts`, `deliveryCursor.ts`).
  * **`src/config/`**: Configuration loading, multi-tier layer resolution (`effectiveConfig.ts`), YAML parsing, DB setup, personality file loaders (`personalities.ts`).
* **`prompts/`**: (Gitignored) Contains local runtime Jules persona files injected into Jules API sessions:
  * `prompts/AGENTS.md` (Agent personality injected into Jules prompt)
  * `prompts/SOUL.md` (Agent soul / identity injected into Jules prompt)
* **`templates/`**: Template defaults for users (`templates/AGENTS.example.md`, `templates/SOUL.example.md`, `templates/config.example.yaml`, `templates/.env.example`).
* **`test/`**: Native test suite using `node:test` (`npm test`).

---

## 3. Important Development Rules & Landmines

1. **Mandatory ESM Extensions**: Always include the `.js` extension on all local imports (e.g. `import { prisma } from '../config.js'`). Omitting it will break ESM resolution at runtime.
2. **Prompts vs Repository Documentation**:
   * **Root `AGENTS.md`** (this file) is **only** for agents developing this repository.
   * **Jules runtime personas** live in `prompts/AGENTS.md` and `prompts/SOUL.md` (loaded via `src/config/personalities.ts`).
3. **Configuration Precedence**: Never access `yamlConfig` directly when dealing with threads or channels. Use `getEffectiveConfig(thread?, member?)` to respect the resolution hierarchy: global YAML ➔ parent channel ➔ forum tag ➔ thread ➔ role.
4. **Discord Limitations**:
   * Discord messages have a strict 2000-character limit; always use `splitMessage()` when outputting text to Discord.
   * Dropdown menus have a hard maximum limit of 25 options.
5. **Database & Migrations**:
   * Prisma schema is at `prisma/schema.prisma`. Run `npm run db:migrate` or `npm run db:generate` when updating models.
6. **Testing**:
   * Run `npm test` to verify pure logic, message formatting, turn queue, and config precedence.
