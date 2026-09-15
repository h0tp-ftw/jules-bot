import { Message } from 'discord.js'
import {
  completeConversationTurn,
  getActiveConversationTurn,
  type ConversationTurnCompletionReason,
} from '../ConversationQueue.js'
import { getLastHumanMessage } from '../discordHistory.js'
import { isDiscordUserMessageActivity } from '../../utils/sessionOutcome.js'
import {
  bindTurnTarget,
  createTurnTargetState,
  resolveTurnTarget,
} from '../../utils/turnTargets.js'
import type { JulesActivity } from '../julesTypes.js'
import type { JulesDiscordChannel } from '../channelTypes.js'

export type StreamTurnTarget = {
  getTarget: (forceRefresh?: boolean) => Promise<Message | null>
  releaseActiveQueuedTurn: (reason: ConversationTurnCompletionReason) => void
  onUserMessaged: (activity: JulesActivity) => void
  onAgentMessagedRecovery: (rawMessage: string) => void
  getCurrentQueuedTurnId: () => string | undefined
}

export function createStreamTurnTarget(
  thread: JulesDiscordChannel,
  isStaleReplay?: (activity: JulesActivity) => boolean,
): StreamTurnTarget {
  const targetState = createTurnTargetState<Message>(getActiveConversationTurn(thread.id))

  const releaseActiveQueuedTurn = (reason: ConversationTurnCompletionReason) => {
    const activeTurn = getActiveConversationTurn(thread.id)
    if (activeTurn) completeConversationTurn(thread.id, reason, activeTurn.id)
  }

  const getTarget = async (forceRefresh = false): Promise<Message | null> => {
    const activeTurn = getActiveConversationTurn(thread.id)
    const resolved = resolveTurnTarget(targetState, activeTurn)
    if (resolved) return resolved

    if (forceRefresh || !targetState.targetFetched) {
      const fetched = await getLastHumanMessage(thread)
      if (fetched) {
        targetState.cachedTarget = fetched
        targetState.targetFetched = true
      }
    }
    return targetState.cachedTarget
  }

  const onUserMessaged = (activity: JulesActivity) => {
    if (isDiscordUserMessageActivity(activity) && !isStaleReplay?.(activity)) {
      bindTurnTarget(targetState, getActiveConversationTurn(thread.id))
    }
  }

  const onAgentMessagedRecovery = (rawMessage: string) => {
    if (rawMessage && !targetState.boundTurnId) {
      const activeTurn = getActiveConversationTurn(thread.id)
      if (activeTurn?.dispatchedAt) {
        bindTurnTarget(targetState, activeTurn)
      }
    }
  }

  const getCurrentQueuedTurnId = () => targetState.boundTurnId

  return {
    getTarget,
    releaseActiveQueuedTurn,
    onUserMessaged,
    onAgentMessagedRecovery,
    getCurrentQueuedTurnId,
  }
}
