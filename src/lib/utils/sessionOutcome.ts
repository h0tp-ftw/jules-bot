import { t, type Messages } from '../../strings.js'

export interface TurnResponseState {
  awaitingAgentReply: boolean
  latestProgress?: string
}

export interface CompletionSummary {
  pullRequestUrl?: string
  latestProgress?: string
}

function activityMessage(activity: any): string {
  return activity?.message || activity?.userMessaged?.message || ''
}

export function isDiscordUserMessageActivity(activity: any): boolean {
  if (activity?.type !== 'userMessaged') return false
  return activityMessage(activity).includes('[Message details - Author Nickname:')
}

export function describeProgressActivity(activity: any): string | undefined {
  if (activity?.type !== 'progressUpdated') return undefined
  const title = activity.title || activity?.progressUpdated?.title || ''
  const description = activity.description || activity?.progressUpdated?.description || ''
  if (!title && !description) return undefined
  return title && description ? `${title}: ${description}` : title || description
}

export function applyActivityToTurnState(
  state: TurnResponseState,
  activity: any,
): TurnResponseState {
  if (isDiscordUserMessageActivity(activity)) {
    return { awaitingAgentReply: true }
  }

  if (activity?.type === 'agentMessaged') {
    return { awaitingAgentReply: false }
  }

  if (state.awaitingAgentReply && activity?.type === 'progressUpdated') {
    return {
      awaitingAgentReply: true,
      latestProgress: describeProgressActivity(activity) || state.latestProgress,
    }
  }

  return state
}

export function deriveTurnResponseState(
  activities: any[],
  processedActivityIds: Set<string>,
): TurnResponseState {
  let state: TurnResponseState = { awaitingAgentReply: false }
  for (const activity of activities) {
    if (processedActivityIds.has(activity.id)) {
      state = applyActivityToTurnState(state, activity)
    }
  }
  return state
}

export function formatCompletionFallback(messages: Messages, summary: CompletionSummary): string {
  if (summary.pullRequestUrl) {
    return t(messages.session.completion_fallback_pr, { url: summary.pullRequestUrl })
  }
  if (summary.latestProgress) {
    return t(messages.session.completion_fallback_progress, { progress: summary.latestProgress })
  }
  return messages.session.completion_fallback
}
