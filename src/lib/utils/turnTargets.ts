// Pure decision logic for which Discord message a stream activity's replies
// and status reactions attach to. The serialized conversation queue is the
// source of truth: each dispatched turn owns the Jules activities it produced.
// Extracted from runJulesStream so the rebinding rules stay unit-testable
// without discord.js or the Jules SDK.

export interface DispatchableTurn<M> {
  id: string
  message: M
  dispatchedAt?: number
  respondedAt?: number
  completedAt?: number
}

export interface TurnTargetState<M> {
  // Queue turn currently bound as the response target, if any.
  boundTurnId?: string
  boundTarget: M | null
  // Last-resort target from a "latest human message" lookup, owned by the
  // caller; rebinding refreshes it so a stale fetch is never preferred.
  cachedTarget: M | null
  targetFetched: boolean
}

// Newly created sessions can emit an agent reply without replaying their
// initial user activity, so an already-dispatched starter turn binds up front.
// An undispatched (or absent) turn starts the state unbound.
export function createTurnTargetState<M>(initialTurn?: DispatchableTurn<M>): TurnTargetState<M> {
  const bound = initialTurn?.dispatchedAt ? initialTurn : undefined
  return {
    boundTurnId: bound?.id,
    boundTarget: bound?.message ?? null,
    cachedTarget: bound?.message ?? null,
    targetFetched: bound !== undefined,
  }
}

// Explicit rebind: bind to the queue's active turn (from the turn's own
// userMessaged echo, or the orchestrator's swallowed-echo recovery), or clear
// the binding when the queue is empty so the caller falls back to fetching
// the latest human message.
export function bindTurnTarget<M>(
  state: TurnTargetState<M>,
  turn: DispatchableTurn<M> | undefined,
): void {
  state.boundTurnId = turn?.id
  state.boundTarget = turn?.message ?? null
  state.cachedTarget = state.boundTarget
  state.targetFetched = state.boundTarget !== null
}

// Resolve the current response target. Deliberately does NOT rebind to a
// newer dispatched queue turn on its own: Jules's stream emits a turn's
// userMessaged echo before any of that turn's replies, so an activity that
// arrives while the binding still points at the previous turn is a *trailing*
// activity of that previous turn (second reply chunk, the sessionCompleted
// after a final reply) and must stay attached to it. An eager rebind here
// would deliver that content to the new turn's message and — worse — let the
// orchestrator complete the new turn before Jules ever answered it. Binding
// only moves via bindTurnTarget (the new turn's own echo, or the orchestrator's
// swallowed-echo recovery on a live agent reply).
// Returns undefined when the caller should fall back to its own lookup.
export function resolveTurnTarget<M>(
  state: TurnTargetState<M>,
  activeTurn: DispatchableTurn<M> | undefined,
): M | undefined {
  if (state.boundTurnId && activeTurn?.id === state.boundTurnId) {
    state.boundTarget = activeTurn.message
  }
  if (state.boundTarget) return state.boundTarget
  if (!state.boundTurnId && activeTurn) return activeTurn.message
  return undefined
}

// True while a queue turn has been sent to Jules but no user-visible response
// (agent reply or plan) has arrived yet.
export function isTurnAwaitingReply(turn: DispatchableTurn<unknown> | undefined): boolean {
  return Boolean(turn?.dispatchedAt && !turn.respondedAt && !turn.completedAt)
}
