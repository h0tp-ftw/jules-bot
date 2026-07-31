import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindTurnTarget,
  createTurnTargetState,
  isTurnAwaitingReply,
  resolveTurnTarget,
  type DispatchableTurn,
} from '../src/lib/utils/turnTargets.js'

type Msg = { id: string }

const turn = (id: string, message: Msg, extra: Partial<DispatchableTurn<Msg>> = {}) => ({
  id,
  message,
  ...extra,
})

test('an already-dispatched starter turn binds up front', () => {
  const m = { id: 'm1' }
  const state = createTurnTargetState(turn('t1', m, { dispatchedAt: 1 }))
  assert.equal(state.boundTurnId, 't1')
  assert.equal(state.boundTarget, m)
  assert.equal(state.targetFetched, true)
  assert.equal(resolveTurnTarget(state, undefined), m)
})

test('an undispatched starter turn leaves the state unbound', () => {
  const state = createTurnTargetState(turn('t1', { id: 'm1' }))
  assert.equal(state.boundTurnId, undefined)
  assert.equal(state.boundTarget, null)
  assert.equal(state.targetFetched, false)
})

test('resolve does NOT rebind to a newly dispatched turn — trailing activities stay attributed', () => {
  const m1 = { id: 'm1' }
  const m2 = { id: 'm2' }
  const state = createTurnTargetState(turn('t1', m1, { dispatchedAt: 1 }))

  // Turn 2 dispatched (turn 1 released). An activity resolved now is a
  // *trailing* activity of turn 1 (second reply chunk, sessionCompleted after
  // the final reply) — it must stay attached to turn 1's message, and the
  // binding must not move, or the orchestrator would complete turn 2 before
  // Jules ever answered it. Binding only moves via bindTurnTarget.
  const resolved = resolveTurnTarget(state, turn('t2', m2, { dispatchedAt: 2 }))
  assert.equal(resolved, m1)
  assert.equal(state.boundTurnId, 't1')
})

test('resolve refreshes the message reference of the same bound turn', () => {
  const m1a = { id: 'm1' }
  const m1b = { id: 'm1' } // fresh Message instance for the same turn
  const state = createTurnTargetState(turn('t1', m1a, { dispatchedAt: 1 }))

  assert.equal(resolveTurnTarget(state, turn('t1', m1b, { dispatchedAt: 1 })), m1b)
  assert.equal(state.boundTarget, m1b)
})

test('resolve does not rebind to an undispatched active turn but can return it', () => {
  const m1 = { id: 'm1' }
  const m2 = { id: 'm2' }

  // Bound state: an undispatched newer turn must not steal the binding.
  const bound = createTurnTargetState(turn('t1', m1, { dispatchedAt: 1 }))
  assert.equal(resolveTurnTarget(bound, turn('t2', m2)), m1)
  assert.equal(bound.boundTurnId, 't1')

  // Unbound state: the active (not yet dispatched) turn is still the best
  // available target, but no binding is recorded.
  const unbound = createTurnTargetState()
  assert.equal(resolveTurnTarget(unbound, turn('t2', m2)), m2)
  assert.equal(unbound.boundTurnId, undefined)
})

test('a bound target survives the queue moving on (trailing activities)', () => {
  const m1 = { id: 'm1' }
  const state = createTurnTargetState(turn('t1', m1, { dispatchedAt: 1 }))

  // Queue drained: the released turn's activities still target its message.
  assert.equal(resolveTurnTarget(state, undefined), m1)
})

test('resolve signals fallback when nothing was ever bound', () => {
  const state = createTurnTargetState()
  assert.equal(resolveTurnTarget(state, undefined), undefined)
  assert.equal(state.targetFetched, false)
})

test('bind rebinds to the active turn and clears when the queue is empty', () => {
  const m1 = { id: 'm1' }
  const m2 = { id: 'm2' }
  const state = createTurnTargetState(turn('t1', m1, { dispatchedAt: 1 }))

  bindTurnTarget(state, turn('t2', m2, { dispatchedAt: 2 }))
  assert.equal(state.boundTurnId, 't2')
  assert.equal(state.boundTarget, m2)

  bindTurnTarget(state, undefined)
  assert.equal(state.boundTurnId, undefined)
  assert.equal(state.boundTarget, null)
  assert.equal(state.targetFetched, false) // caller re-fetches the fallback
})

test('isTurnAwaitingReply is true only for dispatched, unanswered, incomplete turns', () => {
  const m = { id: 'm1' }
  assert.equal(isTurnAwaitingReply(undefined), false)
  assert.equal(isTurnAwaitingReply(turn('t1', m)), false)
  assert.equal(isTurnAwaitingReply(turn('t1', m, { dispatchedAt: 1 })), true)
  assert.equal(isTurnAwaitingReply(turn('t1', m, { dispatchedAt: 1, respondedAt: 2 })), false)
  assert.equal(isTurnAwaitingReply(turn('t1', m, { dispatchedAt: 1, completedAt: 2 })), false)
})
