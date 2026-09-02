import { Message } from 'discord.js'
import {
  completeConversationTurn,
  getActiveConversationTurn,
  type ConversationTurnCompletionReason,
} from '../ConversationQueue.js'
import { getLastHumanMessage } from '../discordHistory.js'
import { isDiscordUserMessageActivity } from '../../utils/sessionOutcome.js'
import type { JulesActivity } from '../julesTypes.js'
import type { JulesDiscordChannel } from '../channelTypes.js'

export type StreamTurnTarget = {
  getTarget: (forceRefresh?: boolean) => Promise<Message | null>
  releaseActiveQueuedTurn: (reason: ConversationTurnCompletionReason) => void
  onUserMessaged: (activity: JulesActivity) => void
  getCurrentQueuedTurnId: () => string | undefined
}

export function createStreamTurnTarget(thread: JulesDiscordChannel): StreamTurnTarget {
  const initialActiveTurn = getActiveConversationTurn(thread.id)
  const initialQueuedTurn = initialActiveTurn?.dispatchedAt ? initialActiveTurn : undefined
  let currentQueuedTurnId: string | undefined = initialQueuedTurn?.id
  let currentQueuedTarget: Message | null = initialQueuedTurn?.message || null
  let cachedTarget: Message | null = currentQueuedTarget
  let targetFetched = currentQueuedTarget !== null

  const releaseActiveQueuedTurn = (reason: ConversationTurnCompletionReason) => {
    const activeTurn = getActiveConversationTurn(thread.id)
    if (activeTurn) completeConversationTurn(thread.id, reason, activeTurn.id)
  }

  const getTarget = async (forceRefresh = false): Promise<Message | null> => {
    const activeTurn = getActiveConversationTurn(thread.id)
    if (currentQueuedTurnId && activeTurn?.id === currentQueuedTurnId) {
      currentQueuedTarget = activeTurn.message
    }
    if (currentQueuedTarget) return currentQueuedTarget
    if (!currentQueuedTurnId && activeTurn) return activeTurn.message

    if (forceRefresh || !targetFetched) {
      const fetched = await getLastHumanMessage(thread)
      if (fetched) {
        cachedTarget = fetched
        targetFetched = true
      }
    }
    return cachedTarget
  }

  const onUserMessaged = (activity: JulesActivity) => {
    if (isDiscordUserMessageActivity(activity)) {
      const activeTurn = getActiveConversationTurn(thread.id)
      currentQueuedTurnId = activeTurn?.id
      currentQueuedTarget = activeTurn?.message || null
      cachedTarget = currentQueuedTarget
      targetFetched = currentQueuedTarget !== null
    }
  }

  const getCurrentQueuedTurnId = () => currentQueuedTurnId

  return {
    getTarget,
    releaseActiveQueuedTurn,
    onUserMessaged,
    getCurrentQueuedTurnId,
  }
}
