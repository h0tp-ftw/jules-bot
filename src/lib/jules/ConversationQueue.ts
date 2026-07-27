import type { Message } from 'discord.js'
import { logger } from '../utils/logger.js'

export type ConversationTurnCompletionReason =
  | 'session_completed'
  | 'session_failed'
  | 'stream_ended'

export interface ConversationTurn {
  id: string
  channelId: string
  message: Message
  enqueuedAt: number
  dispatchedAt?: number
  respondedAt?: number
  nudgedAt?: number
  completedAt?: number
  completionReason?: ConversationTurnCompletionReason
}

export interface ActiveConversationQueueSnapshot {
  turn: ConversationTurn
  pendingCount: number
  depth: number
}

type DispatchConversationTurn = (turn: ConversationTurn) => Promise<boolean>

type QueueEntry = {
  turn: ConversationTurn
  dispatch: DispatchConversationTurn
  preparation: Promise<void>
  nudgeTimer?: NodeJS.Timeout
  resolve: () => void
  reject: (error: unknown) => void
}

type TurnWaiter = {
  promise: Promise<ConversationTurnCompletionReason>
  resolve: (reason: ConversationTurnCompletionReason) => void
  settled: boolean
}

type ChannelQueue = {
  pending: QueueEntry[]
  active?: QueueEntry
  waiter?: TurnWaiter
  draining: boolean
}

const channelQueues = new Map<string, ChannelQueue>()
let nextTurnId = 1

function clearNudgeTimer(entry: QueueEntry | undefined) {
  if (!entry?.nudgeTimer) return
  clearTimeout(entry.nudgeTimer)
  entry.nudgeTimer = undefined
}

function createTurnWaiter(): TurnWaiter {
  let resolvePromise: (reason: ConversationTurnCompletionReason) => void = () => {}
  const waiter: TurnWaiter = {
    promise: new Promise<ConversationTurnCompletionReason>((resolve) => {
      resolvePromise = resolve
    }),
    resolve: () => {},
    settled: false,
  }

  waiter.resolve = (reason) => {
    if (waiter.settled) return
    waiter.settled = true
    resolvePromise(reason)
  }

  return waiter
}

async function drainChannelQueue(channelId: string, state: ChannelQueue) {
  if (state.draining) return
  state.draining = true

  try {
    while (state.pending.length > 0) {
      const entry = state.pending.shift()!
      const waiter = createTurnWaiter()
      state.active = entry
      state.waiter = waiter

      try {
        await entry.preparation
        const waitsForCompletion = await entry.dispatch(entry.turn)
        if (waitsForCompletion && !entry.turn.dispatchedAt) {
          entry.turn.dispatchedAt = Date.now()
        }
        if (waitsForCompletion) {
          const reason = await waiter.promise
          entry.turn.completedAt = Date.now()
          entry.turn.completionReason = reason
        }
        entry.resolve()
      } catch (err) {
        entry.reject(err)
      } finally {
        clearNudgeTimer(entry)
        if (state.active === entry) state.active = undefined
        if (state.waiter === waiter) state.waiter = undefined
      }
    }
  } finally {
    state.draining = false
    if (!state.active && state.pending.length === 0 && channelQueues.get(channelId) === state) {
      channelQueues.delete(channelId)
    }
  }
}

export function enqueueConversationMessage(
  channelId: string,
  message: Message,
  dispatch: DispatchConversationTurn,
  prepare?: () => Promise<void>,
): Promise<void> {
  let state = channelQueues.get(channelId)
  if (!state) {
    state = { pending: [], draining: false }
    channelQueues.set(channelId, state)
  }

  const turn: ConversationTurn = {
    id: `${channelId}:${nextTurnId++}`,
    channelId,
    message,
    enqueuedAt: Date.now(),
  }

  const preparation = prepare
    ? Promise.resolve()
        .then(prepare)
        .catch((err) => {
          logger.warn(`[ConversationQueue] Failed to mark message ${message.id} as queued:`, err)
        })
    : Promise.resolve()

  const result = new Promise<void>((resolve, reject) => {
    state!.pending.push({ turn, dispatch, preparation, resolve, reject })
  })

  logger.debug(
    `[ConversationQueue] Enqueued message ${message.id} for channel ${channelId}; depth=${getConversationQueueDepth(channelId)}`,
  )
  void drainChannelQueue(channelId, state)
  return result
}

export function getActiveConversationTurn(channelId: string): ConversationTurn | undefined {
  return channelQueues.get(channelId)?.active?.turn
}

export function getActiveConversationQueueSnapshots(): ActiveConversationQueueSnapshot[] {
  const snapshots: ActiveConversationQueueSnapshot[] = []
  for (const state of channelQueues.values()) {
    if (!state.active) continue
    snapshots.push({
      turn: state.active.turn,
      pendingCount: state.pending.length,
      depth: state.pending.length + 1,
    })
  }
  return snapshots
}

export function getConversationQueueDepth(channelId: string): number {
  const state = channelQueues.get(channelId)
  if (!state) return 0
  return state.pending.length + (state.active ? 1 : 0)
}

export function markConversationTurnDispatched(channelId: string, turnId?: string): boolean {
  const active = channelQueues.get(channelId)?.active
  if (!active) return false
  if (turnId && active.turn.id !== turnId) return false
  if (!active.turn.dispatchedAt) active.turn.dispatchedAt = Date.now()
  logger.debug(`[ConversationQueue] Dispatched turn ${active.turn.id}`)
  return true
}

export function markConversationTurnResponded(channelId: string, turnId?: string): boolean {
  const active = channelQueues.get(channelId)?.active
  if (!active || !active.turn.dispatchedAt) return false
  if (turnId && active.turn.id !== turnId) return false
  if (!active.turn.respondedAt) active.turn.respondedAt = Date.now()
  clearNudgeTimer(active)
  logger.debug(`[ConversationQueue] Jules responded to turn ${active.turn.id}`)
  return true
}

export function scheduleConversationNudge(
  channelId: string,
  delayMs: number,
  sendNudge: (turn: ConversationTurn) => Promise<void>,
  turnId?: string,
): boolean {
  const active = channelQueues.get(channelId)?.active
  if (!active || !active.turn.dispatchedAt || active.turn.respondedAt || active.turn.completedAt) {
    return false
  }
  if (turnId && active.turn.id !== turnId) return false
  if (!Number.isFinite(delayMs) || delayMs <= 0 || active.nudgeTimer || active.turn.nudgedAt) {
    return false
  }

  const expectedTurnId = active.turn.id
  active.nudgeTimer = setTimeout(() => {
    active.nudgeTimer = undefined
    const current = channelQueues.get(channelId)?.active
    if (
      current !== active ||
      current.turn.id !== expectedTurnId ||
      current.turn.respondedAt ||
      current.turn.completedAt ||
      current.turn.nudgedAt
    ) {
      return
    }

    current.turn.nudgedAt = Date.now()
    logger.info(`[ConversationQueue] Nudging unanswered turn ${current.turn.id}`)
    void sendNudge(current.turn).catch((err) => {
      logger.warn(`[ConversationQueue] Failed to nudge turn ${current.turn.id}:`, err)
    })
  }, delayMs)

  logger.debug(`[ConversationQueue] Scheduled nudge for turn ${active.turn.id} in ${delayMs}ms`)
  return true
}

export function completeConversationTurn(
  channelId: string,
  reason: ConversationTurnCompletionReason,
  turnId?: string,
): boolean {
  const state = channelQueues.get(channelId)
  const active = state?.active
  const waiter = state?.waiter
  if (!active || !active.turn.dispatchedAt || !waiter || waiter.settled) return false
  if (turnId && active.turn.id !== turnId) return false

  active.turn.completedAt = Date.now()
  active.turn.completionReason = reason
  clearNudgeTimer(active)
  waiter.resolve(reason)
  logger.debug(
    `[ConversationQueue] Completed turn ${active.turn.id} for channel ${channelId} (${reason}); remaining=${Math.max(0, getConversationQueueDepth(channelId) - 1)}`,
  )
  return true
}
