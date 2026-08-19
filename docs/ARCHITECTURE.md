# JulesBot Architecture

This document describes the runtime architecture and the parts of JulesBot that are easy to misunderstand from the Discord UI alone. For configuration syntax, see [`CONFIGURATION.md`](./CONFIGURATION.md). For deployment and incident response, see [`OPERATIONS.md`](./OPERATIONS.md).

## Runtime model

JulesBot supports two conversation shapes:

- **Forum mode:** each configured Discord forum post maps to one Jules session. Forum sessions can show a reusable progress/status message and plan approval UI.
- **Shared chatbot mode:** one configured normal text channel maps to one Jules session shared by everyone authorized to speak there. Progress/plan UI is suppressed in favor of conversational replies.

The persistent mapping is stored in SQLite. The process does **not** need to keep a permanent in-memory watcher alive for a conversation to remain usable.

```text
Discord channel/thread
        │
        ▼
DebugSession row (SQLite)
        │  threadId/channelId ⇄ julesSessionId
        ▼
Google Jules session
```

## End-to-end forum flow

A new forum post follows this path:

1. `ThreadCreate` fires in `src/events/threadCreate.ts`.
2. The parent must be the guild's configured forum **or** have an entry in `config.yaml` under `channels:`.
3. JulesBot fetches the starter message after a short delay. A post containing only attachments is valid.
4. Effective configuration is resolved for the thread creator, including channel/tag/thread/role overrides.
5. If `interactive_selection` is enabled—or no repository can be resolved—the bot asks for a repository and branch.
6. Otherwise it creates or consumes a pre-warmed Jules session and writes the `DebugSession` row.
7. `runJulesStream()` starts the bounded watcher for that Jules session.
8. Progress, plans, agent replies, completion, and failure activities are translated back into Discord UI.

Repository/branch selection is constrained by Discord's 25-option select-menu limit. The UI therefore trims long lists and exposes branch search and custom-branch entry when necessary. Connected-repository listing is cached for 30 seconds to avoid repeatedly walking the Jules source list during one selection flow.

## Shared chatbot flow

A configured normal text channel follows a slightly different path:

1. `MessageCreate` confirms the channel matches the guild's configured `chatChannelId` / YAML `chat_channel_id`.
2. The message enters the same per-channel `ConversationQueue` used by forum threads.
3. If no `DebugSession` exists for that channel yet, `initializeChatSession()` creates one.
4. Every later human message is sent to the same Jules session.
5. Plans are automatically redirected back into conversational behavior rather than exposing forum-style plan controls.

The legacy database column is still named `threadId`; for chatbot mode it stores the **text channel ID**.

## Conversation turn queue

`src/lib/jules/ConversationQueue.ts` serializes user turns per Discord thread/channel. This prevents two human messages from being sent into one Jules session at the same time in an uncontrolled order.

Each turn tracks:

- enqueue time;
- dispatch time;
- first agent response time;
- optional one-shot nudge time;
- completion time/reason.

A later Discord message remains queued until the active turn is released. A non-empty `agentMessaged` activity releases the active turn; terminal session states also release it. Showing a plan marks the turn as responded for nudge purposes but does not by itself release the queue.

Queued turns are **process-local**. They are not persisted to SQLite. During graceful shutdown JulesBot attempts to warn users about active/pending queue entries; pending messages may need to be resent after restart.

## Jules request coordinator

All meaningful in-process Jules SDK operation entry points are routed through the singleton in `src/lib/jules/JulesRequestCoordinator.ts`:

- session creation;
- `session.send()`;
- approvals;
- session info/result lookups;
- activity synchronization;
- pre-warming;
- connected repository/source listing.

The coordinator uses `ActivityPollScheduler` to impose one process-wide traffic budget. Defaults are:

| Setting | Default | Meaning |
| --- | ---: | --- |
| active poll interval | 5 s | watcher interval while Jules is actively working |
| idle poll interval | 60 s | watcher interval after reply/wait/completion states |
| idle timeout | 1 h | detach watcher after this much idle time |
| max concurrency | 3 | maximum simultaneous coordinated Jules SDK operations |
| minimum request spacing | 250 ms | minimum gap between coordinated operation starts |
| first 429 cooldown | 30 s + jitter | shared backoff after throttling |
| maximum 429 cooldown | 5 min + jitter | cap for repeated throttling |

A Jules 429 therefore pauses **all coordinated Jules operations** instead of creating independent reconnect storms for every Discord conversation. Some SDK operations can perform multiple internal HTTP requests/pages; the scheduler controls the outer operation rather than individually scheduling those SDK-internal requests.

Rate-limit retries are intentionally different from ordinary stream failures: coordinated operations that hit 429 wait through the shared cooldown and retry rather than consuming `runJulesStream()`'s normal retry counter.

## Bounded activity watching

JulesBot does not run the SDK's long-lived `session.stream()` loop for each session. The installed SDK implements that abstraction using repeated activity-list requests, which becomes expensive when many idle Discord conversations remain attached.

Instead, `runJulesStream()` repeatedly calls incremental `session.activities.hydrate()` through the shared scheduler, then reads the SDK activity cache locally with `session.activities.select()`.

Watcher modes:

```text
new Discord action
      │
      ▼
   ACTIVE
   poll ~5s
      │
      ├─ progress/user activity ────────────────┐
      │                                         │
      └─ agent reply / awaiting input /         │
         awaiting approval / paused / completed│
                          │                     │
                          ▼                     │
                        IDLE                    │
                     poll ~60s                  │
                          │                     │
                    1 hour quiet                │
                          ▼                     │
                       DETACHED                 │
                    zero poll traffic           │
                          │                     │
             next Discord message/action ───────┘
```

Detaching a watcher does **not** delete the Jules session or the `DebugSession` database row. A later Discord message reattaches the watcher and continues the same session.

## Queue-state and ordinary retry limits

Before entering normal activity polling, a session that remains in Jules `queued` state is checked at the active poll interval for at most about **2 minutes**. If it never leaves `queued`, JulesBot posts the configured queued-timeout message, releases the active Discord turn, and detaches the watcher.

For ordinary non-rate-limit stream failures, `runJulesStream()` allows up to **20 consecutive failures**. Reconnect delay starts at 5 seconds, multiplies by 1.5, and caps at 30 seconds. A successfully processed activity resets that failure counter/backoff. Jules 429s use the shared scheduler path described above and do not burn through these 20 attempts.

Permanent Jules-side 403/404-style failures during the Jules operation phase detach the watcher instead of retrying indefinitely.

## Activity delivery and duplicate prevention

`DebugSession` contains a persisted Discord-delivery cursor:

- `lastDeliveredActivityId`;
- `lastDeliveredActivityAt`;
- `deliveryCursorInitialized`.

Before watching a session, JulesBot synchronizes the Jules activity cache and reconstructs the set of activities that have already been delivered to Discord. After a Discord side effect succeeds, the activity cursor is persisted.

This matters across restarts: an activity that Jules produced while the bot was offline can be replayed, while activities already posted to Discord are skipped.

For installations created before the cursor fields existed, JulesBot performs a one-time legacy baseline. It looks at the newest recent message posted by the bot in that Discord conversation, treats older Jules activities as already delivered, persists the resulting cursor, and leaves newer activities eligible for recovery.

## Startup rehydration

Startup intentionally does **not** resurrect every historical Jules session.

`rehydrateActiveStreams()` currently selects at most **10** `DebugSession` rows updated within the last **24 hours**, newest first. It then:

- skips missing/non-supported Discord channels;
- skips archived or locked forum threads;
- skips text-channel sessions if that channel is no longer the configured chatbot channel;
- for records older than the configured idle grace period, checks Jules state through the shared request coordinator;
- leaves stale failed/idle sessions dormant;
- reattaches genuinely active work.

Older sessions remain usable even though they are not proactively rehydrated: the next authorized Discord message can reattach them on demand.

## Forum status UI

`src/lib/streams/StreamManager.ts` manages one reusable status message per forum session.

Behavior:

- progress updates are buffered and deduplicated;
- the last 15 progress log lines are retained in memory;
- edits are debounced for 3 seconds;
- content longer than Discord's message limit is split into reusable silent reply messages;
- overflow replies are rediscovered from recent Discord history after an in-process cache loss;
- completion/failure updates the existing status message rather than posting a new status for every activity.

Chatbot mode skips this progress UI.

## Reactions

There are two reaction systems:

1. **Lifecycle reactions** (`queued`, `in_progress`, `responded`, `awaiting_plan_approval`, `completed`, `failed`) configured under `reactions:`.
2. **Jules-authored reactions**, opt-in via `jules_reactions.enabled`. The prompt teaches Jules an inline marker such as `[[react:👍]]`; JulesBot removes the marker from the displayed text and applies the emoji to the user's Discord message.

A Jules-authored reaction replaces the current lifecycle reaction until a later lifecycle transition changes it again.

## Attachments

Text and attachment-only messages are supported in forum starter messages, forum follow-ups, and the shared chatbot channel.

JulesBot does not upload Discord attachment bytes directly into the Jules API. Instead it appends attachment metadata to the prompt (name, URL, MIME type when known, and size) plus instructions telling Jules to download the attachment inside its workspace if it needs to inspect it.

Attachment URLs should therefore be treated as data made available to the Jules session.

## Completion without a final agent reply

Jules can reach `sessionCompleted` without emitting a final user-facing `agentMessaged` for the latest Discord turn. JulesBot tracks that condition from delivered activity history and posts a truthful fallback instead of silently marking the turn done.

Fallback priority is:

1. a pull-request URL from `session.result()` when available;
2. the latest recorded progress text for the unanswered turn;
3. the generic configured completion fallback.

`session.result()` is attempted through the request coordinator with a 15-second timeout. Failure to retrieve a result is logged but does not prevent completion handling.

## Role-context caveat

Forum sessions do not currently use one role context consistently for every later UI operation. Permission configuration and initial session creation are resolved with the thread creator, but several later message/interaction paths resolve role overrides against the current participant, while some status paths pass no member at all. This means role-specific presentation settings such as `messages`, `reply_mode`, reactions, or nudges can vary by call site after the session is created.

See [`CONFIGURATION.md`](./CONFIGURATION.md) for the exact current behavior. Treat role overrides as reliably creator-context for forum authorization/session initialization, not as a guaranteed immutable per-thread role snapshot for every later response path.

## Plan lifecycle

Jules sessions are created with `requireApproval: true`.

Forum behavior:

- `planGenerated` creates an Approve/Reject UI unless auto-rejection is active;
- Approve calls `session.approve()` through the request coordinator and wakes the watcher;
- Reject does not call an SDK reject endpoint—it removes the controls and asks the user to describe desired changes; the user's next message is sent with `session.send()` while Jules is awaiting approval;
- `/approve` provides a slash-command alternative and verifies that the current Jules state is `awaitingPlanApproval` first.

`auto_reject.enabled` sends a configured feedback directive once per session to steer Jules away from the plan gate.

## Pre-warmed sessions

`src/lib/jules/PreWarmedManager.ts` can keep ready Jules sessions in SQLite so a new forum post avoids some startup/clone delay.

Important details:

- pools are opt-in;
- pool size is per repository + context key;
- maintained pool contexts are global, configured `channels:` IDs (including preconfigured thread IDs), and roles; forum tags do not get an independently provisioned pool;
- pools are consumed only for the effective default branch; selecting another branch creates a fresh session;
- if a matching entry is still warming, initialization waits for up to about 60 seconds before proceeding without it;
- a ready session is revalidated when consumed;
- ready pool entries survive process restarts;
- entries that were still warming when the process stopped are removed on the next startup;
- ready sessions retain the persona/prompt that existed when they were created, so changing persona/config does not rewrite an already-warmed Jules session;
- replenishment runs in the background after consumption.

Pre-warming also consumes Jules API quota and all of its Jules requests pass through the central coordinator.

## Prompt construction

A normal session prompt is assembled in `JulesClient.createSession()` from:

1. resolved `diagnostic_prompt`;
2. resolved agent personality (`AGENTS.md` globally, or context override);
3. resolved soul/persona (`SOUL.md` globally, or context override);
4. optional recursive `bootstrap/` context;
5. delivery-status safety instructions;
6. optional Jules-reaction protocol instructions;
7. the Discord user's issue/message with metadata.

Bootstrap files are read recursively, sorted by relative path, and inserted with a `### FILE: bootstrap/<path>` header. Normal session creation respects the effective `bootstrap` flag. Pre-warming currently appends bootstrap content independently and can therefore retain bootstrap even for a context where normal session creation would resolve `bootstrap: false`; see [`CONFIGURATION.md`](./CONFIGURATION.md) for that caveat and profile/bootstrap resolution details.

## Persistent vs process-local state

| State | Location | Survives restart? |
| --- | --- | --- |
| guild repo/forum/chat bindings | `GuildConfig` in SQLite | yes |
| Discord ⇄ Jules session mapping | `DebugSession` in SQLite | yes |
| activity delivery cursor | `DebugSession` in SQLite | yes |
| pre-warmed session records | `PreWarmedSession` in SQLite | yes |
| active watcher membership | in memory | no |
| processed activity ID set | in memory + reconstructed from cursor | reconstructed |
| per-channel conversation queue | in memory | no |
| nudge timers | in memory | no |
| status progress buffers/timers | in memory | no |
| Jules request scheduler cooldown/state | in memory | no |

This is why a restart can safely recover session mappings but cannot guarantee delivery of later Discord messages that were only waiting in the in-memory conversation queue.

## Startup and shutdown behavior

Startup:

- rejects missing/placeholder Discord or Jules credentials before connecting;
- connects SQLite and applies WAL / `synchronous=NORMAL` / `busy_timeout=5000` pragmas;
- optionally starts the HTTP health endpoint;
- retries transient Discord login/network failures with exponential backoff capped at 120 seconds;
- if Discord reports the daily session-identification limit is exhausted, the process waits through the reported reset window instead of intentionally crash-looping;
- registers slash commands;
- logs per-guild readiness;
- initializes warm pools and recent-session rehydration in the background.

Graceful `SIGINT`/`SIGTERM` shutdown:

- warns active conversation queues (within a small time budget);
- stops the health server;
- disposes status timers/buffers;
- destroys the Discord client;
- disconnects Prisma;
- exits.

An uncaught exception is logged and exits non-zero after cleanup. The shipped PM2 configuration intentionally leaves that process stopped (`autorestart: false`) for inspection. Docker Compose has its own restart policy; see [`OPERATIONS.md`](./OPERATIONS.md).

## Data model

### `GuildConfig`

One row per Discord guild:

- `guildId`;
- `defaultRepo`;
- optional `forumChannelId`;
- optional `chatChannelId`;
- timestamps.

Slash commands write these values. YAML `guilds:` mappings can override them at runtime.

### `DebugSession`

One row per forum thread or configured chatbot channel:

- Discord `threadId`/channel ID;
- `guildId`;
- Jules session ID;
- status/plan message IDs;
- repository name;
- persisted activity-delivery cursor;
- timestamps.

### `PreWarmedSession`

Tracks a Jules session waiting in the warm pool:

- Jules session ID;
- repository;
- optional context key;
- ready flag;
- legacy/optional welcome message field;
- creation time.

## Known recovery/behavior limitations

A few current behaviors are important enough to call out explicitly:

- **Missing forum session rows are not reconstructed from a later reply.** If `ThreadCreate` fails before a `DebugSession` row is created (for example because the starter message could not be retrieved), `MessageCreate` recognizes that the thread belongs to a configured forum but currently does not create a replacement session; the follow-up message is marked failed. This conflicts with the current `starter_message_unavailable` text that suggests replying will start the session and should be treated as a known recovery gap.
- **Forum role context is split by call site.** Creator context is used for permission configuration and initial session creation, but some later UI/delivery settings use the current participant and some paths use no role layer. See the role-context section above.
- **Pre-warm bootstrap handling differs from normal creation.** A context's `bootstrap: false` is honored by normal `JulesClient.createSession()` prompt assembly but not by the current pre-warm prompt builder.
- **Repository selection has no search UI.** Only the first Discord-menu-sized repository set is shown; branch selection has search/custom options.
- **Follow-up watcher reattachment waits up to 5 seconds for history/cursor readiness, then proceeds.** The ready callback normally prevents new activities from being mistaken for history, but the timeout is a latency safeguard rather than an indefinite block.
- **Legacy delivery-cursor and status-overflow recovery inspect only recent Discord history.** The one-time delivery baseline looks at up to 100 recent messages for the latest bot message, and `StreamManager` also scans up to 100 recent messages to rediscover status-overflow replies after losing its in-memory ID cache. Extremely busy threads can push older recovery markers outside that window.
- **A dead/deleted Jules backend session is not automatically replaced.** A 403/404/failed session detaches its watcher, but the `DebugSession` mapping remains. A later Discord follow-up still targets that stored Jules session and may fail rather than transparently creating a new backend session.
- **Forum and shared-chat rebinding behave differently.** An existing forum thread with a `DebugSession` continues to route follow-ups even if `/setup-forum` later points the guild at another forum. A shared text channel is checked against the guild's *current* `chatChannelId` before routing, so moving `/setup-chat` immediately stops handling the old channel even though its historical `DebugSession` row remains.

These are descriptions of the current implementation, not recommended invariants. If the underlying behavior is fixed, update this section and the corresponding tests/docs in the same change.

## Single-process requirement

Run exactly **one process per Discord bot token**. Several correctness mechanisms are intentionally process-local: turn queues, watcher membership, scheduler state, reaction deduplication, and `StreamManager` buffers. PM2 clustering, multiple replicas sharing one token, and Discord.js sharding are not supported by the current architecture.
