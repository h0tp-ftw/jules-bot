// Historical facade for the Jules session lifecycle. Implementation was split
// into focused modules — this barrel preserves the `orchestrator.js` import
// path so consumers stay untouched:
//   channelTypes.ts     shared JulesDiscordChannel type
//   streamRegistry.ts   per-thread stream state + teardown/wake
//   reactions.ts        Discord reaction staging (state- and Jules-driven)
//   discordHistory.ts   thread history lookups (last human msg, bot baseline)
//   deliveryCursor.ts   processed-activity skip set + persisted cursor
//   sessionInfo.ts      fresh session info + completed-session results
//   nudges.ts           unanswered-turn reminder scheduling
//   runJulesStream.ts   the Jules activity polling loop
//   sessionInit.ts      session creation (thread + chatbot) and pre-warm handoff
//   rehydrate.ts        post-restart stream rehydration
export type { JulesDiscordChannel } from './channelTypes.js'
export { scheduleJulesRequest } from './JulesRequestCoordinator.js'
export {
  activeStreams,
  autoRejectedSessions,
  processedActivityIdsMap,
  wakeJulesStream,
} from './streamRegistry.js'
export { getLastHumanMessage } from './discordHistory.js'
export { updateReaction, applyJulesReactions } from './reactions.js'
export { getFreshSessionInfo } from './sessionInfo.js'
export { scheduleNudgeForConversationTurn } from './nudges.js'
export { runJulesStream } from './runJulesStream.js'
export { initializeJulesSession, initializeChatSession } from './sessionInit.js'
export { rehydrateActiveStreams } from './rehydrate.js'
