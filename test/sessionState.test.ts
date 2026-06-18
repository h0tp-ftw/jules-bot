import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reactionStageForState } from '../src/lib/utils/sessionState.js'

test('maps planning and inProgress to the in_progress stage', () => {
  assert.equal(reactionStageForState('planning'), 'in_progress')
  assert.equal(reactionStageForState('inProgress'), 'in_progress')
})

test('maps queued, awaitingPlanApproval, completed and failed to their stages', () => {
  assert.equal(reactionStageForState('queued'), 'queued')
  assert.equal(reactionStageForState('awaitingPlanApproval'), 'awaiting_plan_approval')
  assert.equal(reactionStageForState('completed'), 'completed')
  assert.equal(reactionStageForState('failed'), 'failed')
})

test('returns null for unknown / missing states so the reaction is left untouched', () => {
  assert.equal(reactionStageForState(undefined), null)
  assert.equal(reactionStageForState(null), null)
  assert.equal(reactionStageForState(''), null)
  assert.equal(reactionStageForState('someFutureState'), null)
})
