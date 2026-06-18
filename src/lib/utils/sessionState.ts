// Pure mapping from a Jules session state (from session.info().state) to the
// reaction "stage" key used by the configured `reactions:` map. Kept dependency-
// free so it can be unit-tested without importing discord.js / config / prisma.
//
// Stage keys must match the keys in DEFAULT_MESSAGES-adjacent reaction config
// (src/config.ts `defaultReactions`): queued, in_progress, awaiting_plan_approval,
// completed, failed. ("responded" is event-driven, not a session state, so it has
// no mapping here.)
export function reactionStageForState(state: string | undefined | null): string | null {
  switch (state) {
    case 'queued':
      return 'queued'
    case 'planning':
    case 'inProgress':
      return 'in_progress'
    case 'awaitingPlanApproval':
      return 'awaiting_plan_approval'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    default:
      return null
  }
}
