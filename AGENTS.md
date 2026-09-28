# Agent Guidelines for JulesBot

Repository guidelines for AI coding assistants (Claude, Antigravity, Copilot, Cursor) working directly on the **JulesBot** codebase.

---

## 1. Project Purpose & Architecture

JulesBot is a Discord bot that turns Discord forum threads into interactive **Google Jules** coding-agent sessions, enables shared text-channel conversational chatbot mode, and supports repoless direct-message (DM) conversations.

* **Stack**: TypeScript (ESM) · Node.js (Node 20+) · discord.js v14 · `@google/jules-sdk` · Prisma v7 + SQLite (`@prisma/adapter-better-sqlite3`).

### Message Flow Architecture Map

```
Discord Event (messageCreate / threadCreate)
  │
  ├── message.channel.isDMBased()  ──► dmHandler.ts ──────► processDMMessage()
  ├── message.channel.isThread()   ──► threadHandler.ts ──► processThreadMessage()
  └── channel.type === GuildText   ──► chatHandler.ts ────► processChatChannelMessage()
                                            │
                                            ▼
                                  ConversationQueue.ts (enqueueConversationMessage)
                                            │
               ┌────────────────────────────┴────────────────────────────┐
               ▼                                                         ▼
       New Session Init                                          Existing Session
  ┌─────────────────────────────┐                         ┌─────────────────────────────┐
  │ initializeJulesSession()    │ (threads)               │ sendToExistingSession()     │
  │ initializeChatSession()     │ (text channels)         │ (sessionSender.ts)          │
  │ processDMMessage()          │ (DMs)                   │                             │
  └──────────────┬──────────────┘                         └──────────────┬──────────────┘
                 ▼                                                       ▼
  JulesClient.createSession()                                    session.send()
                 │                                                       │
                 └──────────────────────────┬────────────────────────────┘
                                            ▼
                                    runJulesStream() (runJulesStream.ts)
                                            │
                                            ▼
                           StreamManager.ts / Activity Handlers
```

### Operational Modes

1. **Forum Thread Mode (`threadHandler.ts` / `sessionInit.ts`)**:
   - Tied to a GitHub repo/branch.
   - Generates plan buttons (approve/reject).
   - Injects full diagnostic instructions, `agents_personality`, and `soul_personality`.
2. **Guild Text Chatbot Mode (`chatHandler.ts` / `session/chatSession.ts`)**:
   - Tied to the server's configured chatbot channel (`chat_channel_id`) and default repo.
   - Runs with `chatbotMode: true` (auto-rejects code plans with conversational prompt).
3. **Direct Message Mode (`dmHandler.ts`)**:
   - Runs **repoless** (`repo: 'NO_CODEBASE'`) with no GitHub source attachment.
   - Runs with **`omitPersonas: true`** (omits `agents_personality` and `soul_personality` from prompt).
   - Runs in `chatbotMode: true`.
   - Identified in SQLite `DebugSession` with `threadId: dmChannel.id` and `guildId: 'DM'`.

### Prompt Assembly Flow

Prompt construction occurs in **`JulesClient.createSession`** (`src/lib/jules/JulesClient.ts`):
- `diagnostic_prompt` (from `effectiveConfig`)
- `Agent Personality and Guidelines:` + `agents_personality` (skipped if `omitPersonas: true`)
- `Agent Soul and Principles:` + `soul_personality` (skipped if `omitPersonas: true`)
- `Bootstrap Knowledge and Context:` + `bootstrapContext` (if bootstrap enabled)
- `delivery_status_instruction`
- `jules_reactions_instruction` (if enabled)
- `User Issue:` + initial message content & formatted attachments

Subsequent turns are formatted via `buildReplyAwarePrompt` (`src/lib/utils/reply.ts`) and sent via `session.send(...)`.

---

## 2. Directory Layout & Key Locations

* **`src/`**: Bot application code.
  * **`src/commands/`**: Slash commands (`/link-repo`, `/new`, `/setup-forum`, `/setup-chat`, `/approve`).
  * **`src/events/`**: Discord event handlers (`threadCreate.ts`, `messageCreate.ts`, `interactionCreate.ts`).
  * **`src/events/messages/`**: Message handlers partitioned by context (`threadHandler.ts`, `chatHandler.ts`, `dmHandler.ts`, `sessionSender.ts`).
  * **`src/lib/jules/`**: Jules integration layer.
    * `orchestrator.ts`: Public lifecycle facade re-exporting key functions.
    * `JulesClient.ts`: SDK client wrapper and session factory (`createSession`).
    * `runJulesStream.ts`: Background polling loop receiving Jules activities and driving Discord output.
    * `sessionInit.ts` & `session/`: New session instantiation & pre-warming handoff.
    * `ConversationQueue.ts`: Turn-by-turn serialization per channel.
    * `rehydrate.ts`: Restores active streams on bot startup.
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
   * DMs require `GatewayIntentBits.DirectMessages` and `partials: [Partials.Channel, Partials.Message]`.
5. **Database & Migrations**:
   * Prisma schema is at `prisma/schema.prisma`. Run `npm run db:migrate` or `npm run db:generate` when updating models.
6. **Testing**:
   * Run `npm test` to verify pure logic, message formatting, turn queue, and config precedence.

