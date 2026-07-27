<h1 align="center">🐙 JulesBot</h1>

<p align="center">
  <strong>Turn Discord forum threads or a designated text channel into Google Jules conversations.</strong><br>
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
  JulesBot is a Discord bot designed to act as a <strong>friendly, interactive diagnostic helper</strong> for developers and non-technical stakeholders alike. Powered by the <strong>Google Jules SDK</strong>, it supports isolated sessions in Discord Forum posts and an optional shared chatbot conversation in a normal text channel.
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
* 💬 **Shared Text-Channel Chatbot**: Optionally designate one normal text channel per server; the first human message starts a shared Jules conversation and every later human message continues it.
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

A forum thread becomes an isolated Jules session with plan controls. A configured normal text channel instead keeps one shared conversational session and automatically redirects plans into direct replies.

```
ThreadCreate ─▶ (optional repo/branch pick) ─▶ initializeJulesSession ─▶ JulesClient.createSession
Text Message ─▶ initializeChatSession (first message) ───────────────┘
                                                      │
MessageCreate ─▶ session.send(prompt + metadata)      ▼
InteractionCreate (forum controls) ──────────▶ runJulesStream  ◀── jules-sdk session.stream()
                                                      │
          forum: status msg + plan embeds · text channel: direct conversational replies
```

| Layer | Module | Responsibility |
| :--- | :--- | :--- |
| Bootstrap | `src/index.ts` | Client/intents, event wiring, slash-command registration, presence, lifecycle |
| Events | `src/events/*` | `threadCreate`, `messageCreate`, `interactionCreate` (buttons/menus/modals) |
| Orchestration | `src/lib/jules/orchestrator.ts` | `runJulesStream`, forum/chat initialization, rehydration |
| SDK wrapper | `src/lib/jules/JulesClient.ts` | Prompt assembly + `@google/jules-sdk` calls |
| Warm pools | `src/lib/jules/PreWarmedManager.ts` | Background session pre-warming |
| Streaming | `src/lib/streams/StreamManager.ts` | One editable status message per forum thread |
| Config | `src/config.ts` | Layered YAML + persona resolution via `getEffectiveConfig()` |
| Strings | `src/strings.ts` | Single source of truth for all user-facing copy |

**State of record** lives in SQLite (via Prisma); in-memory stream state is **rehydrated on boot** for both forum threads and configured text channels. See [`CLAUDE.md`](./CLAUDE.md) for the full tour and repo-specific landmines.

---

## 🛠️ Setup & Run

### Prerequisites
- **Node.js** v20 or newer.
- A **Discord application + bot token** (the wizard links you to the portal and prints your invite URL).
- A **Google Jules API key**.

### One-command setup

From a fresh clone:

```bash
npm run setup
```

The interactive wizard walks you through everything:

1. **Discord token** — validated live against the Discord API; it then prints a ready-to-click
   **invite link** carrying exactly the permissions the bot needs (no manual scope/permission math).
2. **Jules API key** — validated by listing your connected repos.
3. Writes `.env` and the runtime config files (`config.yaml`, `AGENTS.md`, `SOUL.md`).
4. Installs dependencies, provisions the SQLite database, and offers to **start the bot**.

Answer the prompts and you're live. Re-run it anytime to reconfigure; in a non-interactive
shell (CI) it just copies the templates.

> ⚠️ The one step Discord can't automate: on the **Bot** page of the Developer Portal, enable
> the **Message Content Intent** toggle. The wizard reminds you. The bot also validates both
> tokens on startup and exits early with a clear message if either is missing.

**Unattended / scripted install?** Skip every prompt with `--yes` — it reads tokens from the
environment, writes `.env`, installs dependencies, and provisions the database:

```bash
DISCORD_TOKEN="…" JULES_API_KEY="…" npm run setup -- --yes
```

### Day-to-day commands

```bash
npm run dev                    # dev (hot reload, debug logs)
npm run build && npm start     # production
npm run doctor                 # pre-flight: verify config, secrets, DB
```

The SQLite database is **auto-provisioned on first boot** — Prisma applies the committed
migrations to a fresh `prisma/dev.db`. (Editing `prisma/schema.prisma`? Use `npm run db:migrate`.)

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

## 🎬 Your first session

Once the bot is **running and invited** to your server, link a repo with `/link-repo owner/repo`, then choose either or both conversation modes:

**Forum mode**
1. Create a Discord Forum channel for debug/support threads.
2. Run `/setup-forum #your-forum` (requires *Manage Server*).
3. Create a post describing an issue. Each post gets its own Jules session, live status message, and **Approve** / **Reject** plan controls.

**Shared chatbot mode**
1. Create or choose a normal Discord text channel.
2. Run `/setup-chat #your-channel` (requires *Manage Server*).
3. Talk normally in that channel. The first human message creates one shared Jules session; every later human message continues the same conversation. Plans and progress UI are suppressed so Jules responds like a regular chatbot.

On startup the bot logs each server's readiness, so a missed step is visible — e.g.
`[Setup] "My Server" not ready — still needs: repo (/link-repo)`.

> Slash commands registered globally can take up to ~1 hour to appear. For instant testing,
> set `DEV_GUILD_ID` in `.env` (the setup wizard offers this).

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
Custom emojis applied to each accepted message depending on its stage. Messages waiting behind an active Jules turn keep the queued reaction (hourglass by default) until dispatched:
```yaml
reactions:
  queued: "⏳"
  in_progress: "⚙️"
  responded: "💬"
  awaiting_plan_approval: "📋"
  completed: "✅"
  failed: "❌"
```

### 4. Response Nudges
Optionally send Jules one reminder when a dispatched message has not received a user-facing reply within the configured interval. The timer is cancelled by an agent reply or visible plan. After a successful nudge, the bot silently replies to the original Discord message so users can see that the reminder occurred:
```yaml
nudge:
  enabled: true
  after_minutes: 5
  notify_discord: true
  message: "Please respond directly to the most recent Discord message now."
  discord_message: "🔔 **No reply after {delay}, so I reminded Jules.**"
```
Both text fields are optional. Without them, the defaults come from `messages.prompts.response_nudge` and `messages.session.nudge_sent`. All nudge settings can also be overridden per channel, tag, thread, or role.

### 5. Interactive Selection
Toggle interactive repository and branch selection on thread creation:
```yaml
interactive_selection: true # Ask developers to select target repo and branch on thread creation
```

### 6. Role-Based Overrides
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

### 7. Tag-Based Overrides
Merge overrides when a forum post carries a matching tag (keyed by tag **name or ID**). A post can have several tags; matches merge in config order. Useful for routing posts by category — e.g. give `urgent` posts a different repo or a more concise prompt:
```yaml
tags:
  "urgent": # Forum tag name or ID
    diagnostic_prompt: "Be extremely concise. Prioritise a fast root-cause answer."
  "feature-request":
    auto_reject:
      enabled: false
```

> Configuration is resolved with the precedence **defaults → global YAML → parent channel → tag → thread → role**. The full annotated reference lives in [`templates/config.example.yaml`](./templates/config.example.yaml).

---

## 🔒 Security & Access Control

- **Secrets** (`DISCORD_TOKEN`, `JULES_API_KEY`) live only in `.env`, which is gitignored — never commit them. The same goes for your runtime `config.yaml`, `AGENTS.md`, and `SOUL.md`.
- **Access** is gated by the `access_control` block (`allow_all`, `allowed_users`, `allowed_roles`), evaluated against commands, forum messages, text-channel chatbot messages, **and** component interactions. Forum threads inherit creator-role overrides; normal text channels evaluate role overrides for the current speaker.
- Set `silent: true` to ignore unauthorized messages without replying.

---

## ⚙️ Discord Developer Portal Configuration

Ensure the following settings are enabled on your bot application page:
1. **Intents**:
   - `Message Content Intent` (Required to read forum posts, threads, and configured text-channel messages)
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
| `/setup-forum` | `channel` (Forum) | `Manage Server` | Assigns the forum where each new post receives its own Jules session. |
| `/setup-chat` | `channel` (Text) | `Manage Server` | Assigns a normal text channel that shares one conversational Jules session. |
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
