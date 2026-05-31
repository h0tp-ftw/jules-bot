# JulesBot - Interactive Diagnostic Discord Assistant

JulesBot is a Discord bot designed to act as a **friendly, interactive diagnostic helper** for developers and non-technical stakeholders alike. Powered by the **Google Jules SDK**, it allows users to have live conversations about their codebase inside Discord Forum channels.

Unlike default automated behaviors that rush to create code changes and Pull Requests, JulesBot's primary goal is **triage and diagnostics**:
1. It explains bugs in simple terms with analogies.
2. It lists raw execution/thinking logs (bash executions, command outputs, test runs) directly in the thread.
3. It gates any proposed code changes with interactive **Approve** and **Reject** buttons.

---

## Features

- **Forum-to-Session Mapping**: One forum post = one unique Google Jules interactive session.
- **Log Streaming**: Live-streams terminal outputs and tool executions into a single, automatically-updated status message per thread (rate-limit safe!).
- **Interactive Gates**: Presents proposed developer plans with Discord button components so humans can review and approve them before execution.
- **Bot Rehydration**: Tracks thread states in a local SQLite database, allowing the bot to reconnect to active sessions seamlessly across bot restarts.
- **Configurable Diagnostic Prompt**: Easily adjust how the AI behaves (e.g., instructing it to use non-technical language) in a single config file.

---

## Architecture

- **discord.js v14**: Interface with Discord API.
- **@google/jules-sdk**: Communicates with the Google Jules API.
- **Prisma 7 & SQLite**: Durable local state persistence.
- **TypeScript**: Complete compile-time type safety.

---

## Installation & Setup

### 1. Prerequisites
- **Node.js** (v18 or higher recommended)
- A Discord Bot account registered on the [Discord Developer Portal](https://discord.com/developers/applications).
- A Google Jules API Key.

### 2. Install Dependencies
Clone the repository and run:
```bash
npm install
```

### 3. Configure Environment Variables
Create a `.env` file in the root directory:
```env
DATABASE_URL="file:./prisma/dev.db"
DISCORD_TOKEN="YOUR_DISCORD_TOKEN"
JULES_API_KEY="YOUR_JULES_API_KEY"

# Access Controls
ALLOW_ALL="true" # Set to "false" to enforce allowlisting
ALLOWED_USERS="123456789012345678,987654321098765432" # Comma-separated Discord User IDs
ALLOWED_ROLES="112233445566778899" # Comma-separated Discord Role IDs
```

### 4. Initialize the Database
Set up the SQLite database schema using Prisma:
```bash
npm run db:migrate -- --name init
```

---

## Discord Developer Portal Setup

To allow the bot to read messages and manage threads:
1. Go to your Bot page in the Discord Developer Portal.
2. Under **Privileged Gateway Intents**, enable:
   - **Guild Members Intent** (Optional)
   - **Message Content Intent** (Required to parse starter messages and replies)
3. Under **Bot Permissions**, grant:
   - Read Messages/View Channels
   - Send Messages
   - Send Messages in Threads
   - Manage Messages (To edit status updates)
   - Read Message History
   - Use Slash Commands

Invite the bot to your server using the generated OAuth2 URL.

---

## How to Run

### Development Mode (with hot reloading)
```bash
npm run dev
```

### Production Mode
Build the TypeScript files and start the production build:
```bash
npm run build
npm run start
```

---

## Commands and Usage

1. **Set Up the Forum Channel**:
   Run `/setup-forum <channel>` to point the bot to your debugging forum.
2. **Link a Repository**:
   Run `/link-repo <owner/repo>` (e.g., `facebook/react`) to link the server to your target GitHub repository.
3. **Start Debugging**:
   Create a new post in the forum. Write your bug report or query. The bot will welcome you, set up a Google Jules session, and stream diagnostics!
4. **Approve/Reject Plans**:
   When Jules proposes a plan, click the **Approve** button to allow it to run or **Reject** to redirect it.
