# Interactive Testing Harness & AI Testing Pipeline

This document details the architecture, configuration, and usage of the **JulesBot Interactive Testing Harness**.

The harness enables developers and automated AI agents to test, inspect, and benchmark JulesBot's conversational behaviors, prompt formatting, stream handling, and plan lifecycles **without connecting to the Discord gateway** or creating live Discord noise.

---

## Why the Harness Exists

In standard operation, JulesBot listens to Discord gateway events (`messageCreate`, `threadCreate`, `interactionCreate`), wraps the user's message with Discord metadata and layered system prompts, sends the request to Google Jules, and streams activities (`planGenerated`, `progressUpdated`, `agentMessaged`) back into Discord.

Testing this lifecycle directly in Discord has major drawbacks:
1. **Developer bottleneck**: Testing requires developer accounts, dedicated testing channels/guilds, and active Discord tokens.
2. **Noise and clutter**: Live test iterations flood channels and thread logs.
3. **Lack of automation**: AI agents and automated CI scripts cannot easily send Discord messages or parse live Discord embed/button states.
4. **Latency & inspection**: You cannot easily inspect the exact assembled prompt, raw activity stream, reaction markers, and delivery latency in real time.

The testing harness solves this by providing a high-fidelity **Virtual Discord Layer** combined with an **Interactive CLI** and a **REST/SSE HTTP API**.

---

## Architecture Overview

```
                      ┌──────────────────────────────────────────────┐
                      │             Test Harness Consumer            │
                      │  (Human CLI · AI Agent · Automated Test API) │
                      └──────────────────────┬───────────────────────┘
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
             [Interactive CLI]                            [HTTP REST / SSE API]
          (scripts/test-harness.ts)                      (src/harness/harnessServer.ts)
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             │
                                             ▼
                                     [HarnessSession]
                               (src/harness/harnessSession.ts)
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              ▼                              ▼                              ▼
    [VirtualDiscordChannel]       [buildReplyAwarePrompt]            [runJulesStream]
  (src/harness/virtualChannel.ts)    (src/lib/utils/reply.ts)    (src/lib/jules/runJulesStream.ts)
              │                              │                              │
              ▼                              ▼                              ▼
  Captures:                         Formats prompt with:           Streams live activities:
  • Raw send/reply payloads         • Author tags & message IDs    • progressUpdated
  • Plan embeds & buttons           • Channel & thread context     • planGenerated (auto-reject / gate)
  • Reactions & typing loops        • Layered system prompts       • agentMessaged (emoji/marker parsed)
  • Status message edits            • Delivery instructions        • sessionCompleted / failed
```

### Key Modules

1. **`src/harness/virtualChannel.ts`**
   - **`VirtualDiscordChannel`**: A duck-typed simulation of `ThreadChannel | TextChannel` from discord.js. Satisfies `channel.send()`, `channel.sendTyping()`, `channel.messages.fetch()`, `channel.fetchStarterMessage()`, and configuration hierarchy lookups (`getEffectiveConfig(virtualChannel)`).
   - **`VirtualDiscordMessage`**: Simulates inbound and outbound messages, tracking `reply()`, `react()`, `edit()`, mentions, and references.
   - **Event Bus**: Emits `message`, `typing`, `reaction`, and `messageEdit` events.

2. **`src/harness/harnessSession.ts`**
   - Manages the lifecycle of a test session.
   - Formats user prompts using `buildReplyAwarePrompt` with genuine metadata headers (matching either shared text channel or thread formatting).
   - Initializes a real Google Jules session (`JulesClient.createSession`) and records the entry in the SQLite `DebugSession` table.
   - Attaches `runJulesStream` to pipe activities into the virtual channel.
   - Provides promise-based turn tracking (`sendUserMessage(text, timeoutMs)`), plan approval (`approvePlan()`), and plan rejection (`rejectPlan(feedback)`).

3. **`src/harness/harnessServer.ts`**
   - Zero-dependency HTTP server (`node:http`) exposing REST endpoints and Server-Sent Events (SSE).
   - Can run embedded inside the main bot process (`HARNESS_PORT=3100`) or standalone (`npm run harness:server`).

4. **`scripts/test-harness.ts`**
   - Dual-mode CLI tool:
     - **Interactive REPL**: Real-time terminal conversation with live progress indicators.
     - **Single-Query Runner**: Executes a single prompt, captures diagnostics, and outputs formatted text or raw JSON.
     - **Remote Client**: Connects via HTTP to a running bot instance (such as on your SSH host `openclaw`).

---

## Usage Guide

### 1. Interactive Terminal REPL (Local In-Process)

Run a local interactive terminal chat using your `.env` credentials (`JULES_API_KEY`):

```bash
npm run harness
```

#### Customizing Session Parameters
```bash
# Test a specific repository and channel in chatbot mode
npm run harness -- --repo h0tp-ftw/ankimon --channel 1382329537676705792 --mode chatbot

# Test a forum thread (gates plans behind approval buttons)
npm run harness -- --repo h0tp-ftw/ankimon --channel 1511268531369545869 --mode forum
```

In the interactive REPL:
- Type your question and press Enter.
- Watch real-time Jules progress steps (`⏳ [Jules Status] ...`).
- If Jules generates an implementation plan, the plan steps or auto-reject notice will be printed.
- Once Jules responds, the final formatted reply (with emojis and reaction markers processed) will appear.
- Type `exit` to close the session and clean up the database records.

---

### 2. Single-Query Mode (For Automated AI Pipeline & Scripts)

Send a question non-interactively and exit once the agent replies:

```bash
npm run harness -- --query "Where is the battle streak logic located?"
```

#### Structured JSON Output
For automated evaluation, benchmarking, or consumption by an AI agent, use `--json`:

```bash
npm run harness -- --query "Explain the XP calculation in Ankimon" --json
```

**Example JSON Output**:
```json
{
  "reply": "XP calculation is handled in the `battle_manager.py` file under `calculate_xp()`...",
  "planProposed": false,
  "latencyMs": 14250,
  "transcript": {
    "messages": [
      {
        "id": "vmsg-1382329537676705792-1",
        "author": "Tester",
        "isBot": false,
        "content": "Explain the XP calculation in Ankimon",
        "createdAt": "2026-09-24T19:00:00.000Z"
      },
      {
        "id": "vmsg-1382329537676705792-2",
        "author": "JulesBot",
        "isBot": true,
        "content": "XP calculation is handled in the `battle_manager.py` file under `calculate_xp()`...",
        "createdAt": "2026-09-24T19:00:14.250Z"
      }
    ],
    "events": [
      {
        "type": "progress",
        "data": { "title": "Searching battle manager", "description": "Grep for calculate_xp" },
        "timestamp": 1790276405000
      },
      {
        "type": "agent_reply",
        "data": { "content": "XP calculation is handled..." },
        "timestamp": 1790276414250
      }
    ]
  }
}
```

---

### 3. Remote Live Bot Interaction (`openclaw`)

You can interact directly with the running bot on your remote SSH server (`openclaw`) without touching Discord.

#### Step 1: Enable the Harness on `openclaw`
In `/home/ubuntu/.openclaw/jules-bot/.env`, set:
```bash
HARNESS_PORT=3100
```
Then reload the PM2 service:
```bash
pm2 reload jules-bot
```

#### Step 2: Query the Remote Bot
From your local machine (connected via Tailscale IP `100.94.190.37` or SSH tunnel):

```bash
# Query the live bot on openclaw
npm run harness -- --url http://100.94.190.37:3100 --query "Test diagnostic query" --json
```

---

## HTTP REST & SSE API Reference

When the harness server is running (either standalone via `npm run harness:server` or inside the bot via `HARNESS_PORT`), the following endpoints are available:

### Health Check
- **`GET /health`** or **`GET /api/harness/health`**
- Returns: `{ "status": "ok", "activeSessions": 1 }`

### Create Session
- **`POST /api/harness/sessions`**
- **Request Body**:
  ```json
  {
    "repo": "h0tp-ftw/ankimon",
    "branch": "main",
    "channelId": "1382329537676705792",
    "mode": "chatbot",
    "initialPrompt": "How do I install Ankimon?",
    "authorName": "Alice",
    "waitForFirstReply": true,
    "timeoutMs": 120000
  }
  ```
- **Response** (201 Created):
  ```json
  {
    "sessionId": "harness-1790276400000-abcde",
    "julesSessionId": "1234567890123456789",
    "channelId": "1382329537676705792",
    "firstReply": "To install Ankimon, download the latest .ankiaddon file..."
  }
  ```

### Send Message
- **`POST /api/harness/sessions/:sessionId/messages`**
- **Request Body**:
  ```json
  {
    "content": "Where do save files get stored?",
    "authorName": "Alice",
    "waitForReply": true,
    "timeoutMs": 120000
  }
  ```
- **Response** (200 OK):
  ```json
  {
    "reply": "Save files are stored in the user profile directory...",
    "latencyMs": 8420
  }
  ```

### Stream Real-Time Events (SSE)
- **`GET /api/harness/sessions/:sessionId/events`**
- Standard Server-Sent Events stream (`text/event-stream`). Emits:
  - `data: {"type": "connected", "sessionId": "..."}`
  - `data: {"type": "progress", "data": {...}}`
  - `data: {"type": "plan_proposed", "data": {...}}`
  - `data: {"type": "plan_auto_rejected", "data": {...}}`
  - `data: {"type": "agent_reply", "data": {...}}`

### Plan Approval / Rejection
- **`POST /api/harness/sessions/:sessionId/approve`**: Approves a proposed plan.
- **`POST /api/harness/sessions/:sessionId/reject`**: Rejects a plan with optional feedback (`{ "feedback": "..." }`).

### Delete Session
- **`DELETE /api/harness/sessions/:sessionId`**: Closes the virtual session and deletes temporary SQLite debug records.

---

## Automated Tests

The harness is covered by unit tests in [`test/harness.test.ts`](file:///c:/Users/h0tp/Documents/Code/jules-bot/test/harness.test.ts):
- Verifies virtual channel message creation, reply references, and emoji reactions.
- Validates configuration resolution inheritance (`getEffectiveConfig`).
- Verifies compatibility with message delivery (`deliverWithReply`).
- Confirms HTTP server health check lifecycle.

Run the test suite:
```bash
npm test
```
