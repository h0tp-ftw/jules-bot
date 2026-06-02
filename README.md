<h1 align="center">🐙 JulesBot</h1>

<p align="center">
  <strong>Interactive Diagnostic Discord Assistant</strong>
</p>

<p align="center">
  <a href="https://discord.js.org/"><img src="https://img.shields.io/badge/Discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord.js"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"></a>
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
* ⏳ **Message Queueing**: Queues user messages while Jules is busy, sending them combined with a separator (`\n\n---\n\n`) when the active turn completes.
* 👥 **Role-Based Overrides**: Define role-specific configuration overrides (e.g. customized prompts, auto-reject flags, reactions) applied dynamically.
* 🔒 **Creator-Context Permissions**: Dynamic thread permissions evaluated relative to the thread creator. If a Developer starts a thread, it automatically inherits Developer role overrides and restrictions.
* 📋 **Interactive Selection**: Supports interactive dropdown select menus to choose the GitHub repository and branch on thread creation (toggled via `interactive_selection`).



---

## 🛠️ Setup & Run

### 1. Prerequisites
- **Node.js** (v18+)
- **Python 3.10+** (Required for Docling document/image parsing)
- A Discord Application token with proper intents.
- A Google Jules API Key.

### 2. Set Up Python Virtual Environment & Docling
JulesBot uses **Docling** to parse files like PDFs, images, DOCX, etc., into Markdown. Setting up a local virtual environment (`.venv`) is required.

1. **Create Virtual Environment:**
   ```bash
   python -m venv .venv
   ```

2. **Install Docling:**
   *Tip: We recommend installing the CPU-only version of PyTorch to save disk space and resources on your bot host.*

   - **Windows:**
     ```powershell
     .venv\Scripts\pip install docling --extra-index-url https://download.pytorch.org/whl/cpu
     ```
   - **macOS / Linux:**
     ```bash
     .venv/bin/pip install docling --extra-index-url https://download.pytorch.org/whl/cpu
     ```

3. **Pre-hydrate weights (Optional but Highly Recommended):**
   Docling downloads layout and OCR model weights (approx. 300-500MB) on its first run. To prevent the bot from hitting process execution timeouts during active threads, run a manual conversion to cache the models beforehand:
   - **Windows:**
     ```powershell
     .venv\Scripts\python scripts/parse_document.py bootstrap/bootstrap_pieces/image.png
     ```
   - **macOS / Linux:**
     ```bash
     .venv/bin/python scripts/parse_document.py bootstrap/bootstrap_pieces/image.png
     ```

### 3. Configure Settings & Environment
1. Run the interactive setup script to copy default templates to their local gitignored files:
   ```bash
   npm run setup
   ```
   This generates:
   - `.env` (Environment variables)
   - `config.yaml` (YAML configurations)
   - `AGENTS.md` (Agent guidelines)
   - `SOUL.md` (Agent principles)

2. Open `.env` and fill in your Discord credentials and Jules API key:
   ```env
   DATABASE_URL="file:./prisma/dev.db"
   DISCORD_TOKEN="YOUR_DISCORD_TOKEN"
   JULES_API_KEY="YOUR_JULES_API_KEY"
   ```



### 4. Initialize Database
```bash
npm install
npm run db:migrate -- --name init
```

### 5. Start the Bot
```bash
# Run in development mode (hot reload)
npm run dev

# Run in production mode
npm run build
npm run start
```

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

## 🕹️ Command Reference

| Command | Arguments | Permissions | Description |
| :--- | :--- | :--- | :--- |
| `/setup-forum` | `channel` (Forum) | `Manage Server` | Assigns the designated channel where Jules bot will spin up debug sessions. |
| `/link-repo` | `repository` (owner/repo) | `Manage Server` | Links a target GitHub repository to the server as the default codebase. |
