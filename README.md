<h1 align="center">🐙 JulesBot</h1>

<p align="center">
  <strong>Turn Discord forum threads into interactive Google Jules coding-agent sessions.</strong><br>
  <em>Diagnose first — change only on human approval.</em>
</p>

<p align="center">
  <a href="https://github.com/h0tp-ftw/jules-bot/actions/workflows/ci.yml"><img src="https://github.com/h0tp-ftw/jules-bot/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node >= 20">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome">
</p>

<p align="center">
  <a href="https://discord.js.org/"><img src="https://img.shields.io/badge/Discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord.js"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-6.x-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.prisma.io/"><img src="https://img.shields.io/badge/Prisma-v7-2D3748?style=for-the-badge&logo=prisma&logoColor=white" alt="Prisma"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/SQLite-3-07405E?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite"></a>
  <a href="https://jules.google.com"><img src="https://img.shields.io/badge/Powered%20by-Jules-4285F4?style=for-the-badge&logo=google&logoColor=white" alt="Jules"></a>
  <a href="https://labs.google/"><img src="https://img.shields.io/badge/Google-Labs-F4B400?style=for-the-badge&logo=google&logoColor=white" alt="Google Labs"></a>
</p>

<p align="center">
  JulesBot is a Discord bot designed to act as a <strong>friendly, interactive diagnostic helper</strong> for developers and non-technical stakeholders alike. Powered by the <strong>Google Jules SDK</strong>, it enables live conversations about your codebase inside Discord Forum channels.
</p>

---

## 🚀 The Triage Approach

Unlike standard AI coding agents that immediately modify code and rush to open Pull Requests, JulesBot focuses on **diagnostics first**:

```
[User Forum Post] ➔ [Init Jules Session] ➔ [Stream live steps in Status message] ➔ [Wait for Human Button Gate] ➔ [Diagnose/Fix]
```

1. 🗣️ **Clear Explanations**: Translates bugs and issues into simple terms with everyday analogies instead of programmer jargon.
2. ⚙️ **Real-Time Logs**: Streams live terminal outputs and step progress inside a single status message.
3. 🛑 **Interactive Gating**: Any proposed code adjustments are presented with interactive **Approve** and **Reject** buttons before execution.

---

## ✨ Features

* 📁 **Forum-to-Session Mapping**: Each forum post automatically initializes a unique interactive Google Jules session.
* ⚡ **Live Log Streaming**: Stream terminal executions and tools into a single status message without hitting Discord rate limits.
* 🛡️ **Access Control allowlists**: Allowlist commands and debug thread usage by User IDs, Role IDs, or toggle globally.
* 🔌 **Seamless Recovery**: Database-backed rehydration re-establishes streaming listeners on bot restarts or serverless pauses.
* ⚙️ **YAML Configuration**: Keep access control, guild overrides, and behavior in `config.yaml` (gitignored, copy from `config.example.yaml`).
* 🎭 **Custom Personality (AGENTS.md)**: Shape the agent's behavior and tone using a custom `AGENTS.md` file (gitignored, copy from `AGENTS.example.md`).
* 🏷️ **Dynamic Status Reactions**: Automatically react to thread starter messages with configurable emojis (unicode or custom Discord emojis like `<:name:id>`).
* 💬 **Context & Conversational Replies**: Injects nickname, message time, and thread title metadata into prompt headers. Replies directly to the user's message.
* 🤖 **Plan Auto-Rejection Mode**: Configure the bot to automatically reject proposed plans once with customizable feedback to trigger plan revisions.
* ✍️ **Typing Indicator**: Shows the bot is active/thinking in Discord while streaming operations.
* 🌡️ **Pre-warmed Session Pools**: Opt-in background session pre-warming to bypass cloning/queueing delays on new thread creations.
* 👥 **Role-Based Overrides**: Define role-specific configuration overrides (e.g. customized prompts, auto-reject flags, reactions) applied dynamically.
* 🔒 **Creator-Context Permissions**: Dynamic thread permissions evaluated relative to the thread creator. If a Developer starts a thread, it automatically inherits Developer role overrides and restrictions.
* 📋 **Interactive Selection**: Supports interactive dropdown select menus to choose the GitHub repository and branch on thread creation (toggled via `interactive_selection`).
* 🌍 **Fully Customizable Copy**: Every user-facing string lives in `src/strings.ts` and is overridable per global/channel/thread/role via the `messages:` block.

---

## 🧩 Architecture

A forum thread becomes a Jules session; activity streams back into the thread; the human gates the plan.

```
ThreadCreate ─▶ (optional repo/branch pick) ─▶ initializeJulesSession ─▶ JulesClient.createSession
                                                      │                          │
MessageCreate ─▶ session.send(prompt + metadata)      ▼                          ▼
InteractionCreate (Approve/Reject) ──────────▶ runJulesStream  ◀── jules-sdk session.stream()
                                                      │
                    StreamManager (status msg) · reactions · plan embeds · auto-reject
```

| Layer | Module | Responsibility |
| :--- | :--- | :--- |
| Bootstrap | `src/index.ts` | Client/intents, event wiring, slash-command registration, presence, lifecycle |
| Events | `src/events/*` | `threadCreate`, `messageCreate`, `interactionCreate` (buttons/menus/modals) |
| Orchestration | `src/lib/jules/orchestrator.ts` | `runJulesStream`, `initializeJulesSession`, rehydration |
| SDK wrapper | `src/lib/jules/JulesClient.ts` | Prompt assembly + `@google/jules-sdk` calls |
| Warm pools | `src/lib/jules/PreWarmedManager.ts` | Background session pre-warming |
| Streaming | `src/lib/streams/StreamManager.ts` | One editable status message per thread |
| Config | `src/config.ts` | Layered YAML + persona resolution via `getEffectiveConfig()` |
| Strings | `src/strings.ts` | Single source of truth for all user-facing copy |

**State of record** lives in SQLite (via Prisma); in-memory stream state is **rehydrated on boot** from sessions touched in the last 7 days. See [`CLAUDE.md`](./CLAUDE.md) for the full tour and repo-specific landmines.

---

## 🛠️ Setup & Run

### 1. Prerequisites
- **Node.js** v20 or newer.
- A Discord Application token with the **Message Content** intent.
- A Google Jules API Key.

### 2. Configure Settings & Environment
Run the interactive setup script. It **prompts for your Discord token and Jules API
key** and writes a ready-to-run `.env`, then copies the other gitignored runtime files
from their committed templates:

```bash
npm run setup
```

This generates:
- `.env` (Environment variables — pre-filled with the tokens you entered)
- `config.yaml` (YAML configurations)
- `AGENTS.md` (Agent guidelines)
- `SOUL.md` (Agent principles)

You can re-open `.env` at any time to adjust values:
```env
DATABASE_URL="file:./prisma/dev.db"
DISCORD_TOKEN="YOUR_DISCORD_TOKEN"
JULES_API_KEY="YOUR_JULES_API_KEY"
LOG_LEVEL="info"   # debug | info | warn | error
```
> The bot validates both tokens on startup and exits early with a clear message if either is missing.

### 3. Install Dependencies
```bash
npm install
```
The SQLite database is **auto-provisioned on first boot** — Prisma applies the committed
migrations to a fresh `prisma/dev.db`, so no manual migration step is needed for a standard
setup. (Editing `prisma/schema.prisma`? Use `npm run db:migrate` to create a new migration.)

Run a pre-flight check anytime to confirm everything is configured:
```bash
npm run doctor
```

### 4. Start the Bot
```bash
# Run in development mode (hot reload)
npm run dev

# Run in production mode
npm run build
npm run start
```

### 🐳 Run with Docker (alternative)

Prefer containers? After `npm run setup` (to create `.env`):

```bash
docker compose up -d        # build the image and start the bot
docker compose logs -f      # follow logs
```

- The SQLite database persists in **`./data`** on the host — easy to back up.
- Compose enables the `/health` endpoint on port `3000` and wires it into the
  container healthcheck (`docker ps` then shows `healthy` / `unhealthy`).
- To use a custom `config.yaml` / `AGENTS.md` / `SOUL.md`, uncomment the bind
  mounts in `docker-compose.yml`; without them the baked-in template defaults apply.

---

## ⚙️ Configuration File (config.yaml)

The `config.yaml` file allows you to customize the bot's behavior. Below are the key configuration blocks:

### 1. Plan Auto-Rejection
Automatically rejects the first proposed plan from Jules and sends a custom revision feedback message:
```yaml
auto_reject:
  enabled: true # Enable/disable auto-reject
  message: "Please double check the proposed changes and ensure no unnecessary modifications are made."
```

### 2. Pre-warmed Session Pools
Pre-creates interactive Jules sessions in the background to reduce initial startup delays on new thread creations:
```yaml
pre_warmed_sessions:
  enabled: true # Enable/disable pre-warming pool
  pool_size: 2  # Number of warm sessions to maintain per repository
```

### 3. Status Reactions
Custom emojis applied to the thread starter message depending on the session stage:
```yaml
reactions:
  queued: "⏳"
  in_progress: "⚙️"
  awaiting_plan_approval: "📋"
  completed: "✅"
  failed: "❌"
```

### 4. Interactive Selection
Toggle interactive repository and branch selection on thread creation:
```yaml
interactive_selection: true # Ask developers to select target repo and branch on thread creation
```

### 5. Role-Based Overrides
Merge specific overrides based on the thread creator's role (supports restricting access per role):
```yaml
roles:
  "Developer": # Role Name or Role ID
    access_control:
      allow_all: false
      allowed_roles:
        - "Developer"
        - "Admin"
    diagnostic_prompt: "Provide deep technical diagnostic details."
```

> Configuration is resolved with the precedence **defaults → global YAML → parent channel → thread → role**. The full annotated reference lives in [`templates/config.example.yaml`](./templates/config.example.yaml).

---

## 🔒 Security & Access Control

- **Secrets** (`DISCORD_TOKEN`, `JULES_API_KEY`) live only in `.env`, which is gitignored — never commit them. The same goes for your runtime `config.yaml`, `AGENTS.md`, and `SOUL.md`.
- **Access** is gated by the `access_control` block (`allow_all`, `allowed_users`, `allowed_roles`), evaluated against commands, thread messages, **and** component interactions (Approve/Reject buttons, select menus). The thread creator can always use their own thread.
- Set `silent: true` to ignore unauthorized messages without replying.

---

## ⚙️ Discord Developer Portal Configuration

Ensure the following settings are enabled on your bot application page:
1. **Intents**:
   - `Message Content Intent` (Required to read forum posts and thread content)
2. **Permissions**:
   - `Read Messages/View Channels`
   - `Send Messages`
   - `Send Messages in Threads`
   - `Manage Messages` (Required to edit the status message)
   - `Use Slash Commands`

---

## 📦 Production Deployment

The repo ships with `pm2` as a dependency for process supervision:

```bash
npm ci
npm run build
DATABASE_URL="file:./prisma/dev.db" npx prisma migrate deploy   # apply committed migrations
pm2 start ecosystem.config.cjs                                  # fork mode, single instance
pm2 save
```

Operational notes:

- **Graceful shutdown** — `SIGINT`/`SIGTERM` flush pending status edits, destroy the Discord client, and disconnect Prisma, so `pm2 reload jules-bot` deploys cleanly. An uncaught exception shuts down and exits non-zero so pm2 restarts a fresh process.
- **Single instance per token** — coordination state (active streams, dedup sets) is in-process, so run exactly **one** instance per bot token. `ecosystem.config.cjs` pins fork mode + one instance; Discord.js sharding is not supported.
- **Durable SQLite** — on boot the bot enables WAL mode (`synchronous=NORMAL`, `busy_timeout=5000ms`) so the database survives abrupt power loss far better — worth knowing on SD-card hosts like a Raspberry Pi.
- **Back up `prisma/dev.db`** — it is the source of truth for the thread⇄session mapping used to rehydrate streams after a restart. (In WAL mode you'll also see transient `dev.db-wal` / `dev.db-shm` sidecar files.)
- **Log verbosity** — set `LOG_LEVEL` (`debug`/`info`/`warn`/`error`, default `info`). `info` keeps production to lifecycle + warnings + errors; `debug` shows the full per-activity trace (`npm run dev` enables it automatically). Every line is prefixed with an ISO timestamp + level.
- **Health endpoint** — set `HEALTHCHECK_PORT` (e.g. `3000`) to expose `GET /health`, returning JSON and a `200` only when the Discord gateway is connected **and** SQLite is reachable (`503` otherwise). Wire it into Docker/k8s/uptime probes to catch a "process alive but gateway dropped" zombie. Unset = disabled.
- **Instant slash commands** — global command registration can take up to ~1 hour to propagate. Set `DEV_GUILD_ID` to register commands to a single guild instantly (ideal for first-run setup and testing).
- **Multiple bots** — use `--profile <name>` (or `BOT_PROFILE`) to isolate `.env`, `config.yaml`, persona files, `bootstrap/`, and the database under `profiles/<name>/`.

---

## 🕹️ Command Reference

| Command | Arguments | Permissions | Description |
| :--- | :--- | :--- | :--- |
| `/setup-forum` | `channel` (Forum) | `Manage Server` | Assigns the designated channel where Jules bot will spin up debug sessions. |
| `/link-repo` | `repository` (owner/repo) | `Manage Server` | Links a target GitHub repository to the server as the default codebase. |
| `/approve` | — | Allowlisted users | Approves the pending Jules plan in the current thread (a slash-command alternative to the **Approve** button). |

---

## 🤝 Contributing

Contributions are welcome! See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local setup,
the build/test workflow, and the codebase conventions (ESM `.js` imports, the
`src/strings.ts` copy catalog, and `getEffectiveConfig` precedence). CI runs
`npm run build` + `npm test` on every PR.

## 📄 License

Released under the [MIT License](./LICENSE).
