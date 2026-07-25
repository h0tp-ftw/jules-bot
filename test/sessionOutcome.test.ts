import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MESSAGES } from '../src/strings.js'
import {
  applyActivityToTurnState,
  deriveTurnResponseState,
  formatCompletionFallback,
  isDiscordUserMessageActivity,
} from '../src/lib/utils/sessionOutcome.js'

const discordUserMessage = {
  id: 'user-1',
  type: 'userMessaged',
  message:
    '[Message details - Author Nickname: Misty, Author Username: misty, Author Discord ID: 1, Message Time: 2026-07-25T00:00:00.000Z]\n\nIs it fixed?',
}

test('recognizes Discord-originated user activities but ignores bot directives', () => {
  assert.equal(isDiscordUserMessageActivity(discordUserMessage), true)
  assert.equal(
    isDiscordUserMessageActivity({
      type: 'userMessaged',
      message: 'Please do not create or refine an implementation plan.',
    }),
    false,
  )
})

test('tracks an unanswered Discord turn through progress and clears it on agent reply', () => {
  let state = applyActivityToTurnState({ awaitingAgentReply: false }, discordUserMessage)
  assert.deepEqual(state, { awaitingAgentReply: true })

  state = applyActivityToTurnState(state, {
    type: 'progressUpdated',
    title: 'Running tests',
    description: 'All checks passed',
  })
  assert.deepEqual(state, {
    awaitingAgentReply: true,
    latestProgress: 'Running tests: All checks passed',
  })

  state = applyActivityToTurnState(state, {
    type: 'agentMessaged',
    message: 'The fix is ready for review.',
  })
  assert.deepEqual(state, { awaitingAgentReply: false })
})

test('reconstructs an unanswered turn from only delivered history activities', () => {
  const activities = [
    { ...discordUserMessage },
    {
      id: 'progress-1',
      type: 'progressUpdated',
      title: 'Code review',
      description: 'Ready for review',
    },
    { id: 'future-agent', type: 'agentMessaged', message: 'Not delivered yet' },
  ]

  const state = deriveTurnResponseState(activities, new Set(['user-1', 'progress-1']))
  assert.deepEqual(state, {
    awaitingAgentReply: true,
    latestProgress: 'Code review: Ready for review',
  })
})

test('completion fallback reports a PR without claiming it was merged', () => {
  const message = formatCompletionFallback(DEFAULT_MESSAGES, {
    pullRequestUrl: 'https://github.com/example/repo/pull/42',
  })

  assert.match(message, /pull request was reported/i)
  assert.match(message, /Merge status was not verified/)
  assert.doesNotMatch(message, /merged into main/i)
})

test('completion fallback includes the latest progress when no PR was reported', () => {
  const message = formatCompletionFallback(DEFAULT_MESSAGES, {
    latestProgress: 'Running code review: all checks passed',
  })

  assert.match(message, /Running code review: all checks passed/)
  assert.match(message, /No pull request or merge was confirmed/)
})
