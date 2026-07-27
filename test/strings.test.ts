import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MESSAGES, deepMergeMessages, t, type Messages } from '../src/strings.js'

test('t fills known placeholders', () => {
  assert.equal(
    t('{emoji} repo `{repo}` on `{branch}`', { emoji: '🐙', repo: 'a/b', branch: 'main' }),
    '🐙 repo `a/b` on `main`',
  )
})

test('t coerces numbers and leaves unknown placeholders untouched', () => {
  assert.equal(t('**{number}.** {title}', { number: 3, title: 'Step' }), '**3.** Step')
  assert.equal(t('hello {missing}', { other: 'x' }), 'hello {missing}')
})

test('t returns the template unchanged when no vars are given', () => {
  assert.equal(t('plain string'), 'plain string')
})

test('t is single-pass: substituted values are not re-scanned', () => {
  // A value that itself looks like a placeholder must not be expanded again.
  assert.equal(t('{content}', { content: '{id}', id: 'LEAK' }), '{id}')
})

test('t skips null/undefined values', () => {
  assert.equal(t('a {x} b', { x: null }), 'a {x} b')
  assert.equal(t('a {x} b', { x: undefined }), 'a {x} b')
})

test('nudge notice reports the configured delay', () => {
  assert.equal(
    t(DEFAULT_MESSAGES.session.nudge_sent, { delay: '5 minutes' }),
    '🔔 **Jules had not replied after 5 minutes, so I sent a reminder.**',
  )
})

test('shutdown queue notice includes the pending-message summary', () => {
  const pending = t(DEFAULT_MESSAGES.session.shutdown_queue_pending_many, { count: 2 })
  assert.equal(
    t(DEFAULT_MESSAGES.session.shutdown_queue_active, { pending }),
    '🛑 **The bot is stopping while this message is active.**\nJules may continue working, but Discord delivery is paused until the bot returns. Please resend this message only if no reply appears after restart.\n⚠️ **2 later queued messages are held only in memory and may need to be resent.**',
  )
})

test('deepMergeMessages overrides a single leaf and keeps siblings', () => {
  const merged = deepMergeMessages(DEFAULT_MESSAGES, {
    errors: { session_not_found: 'gone' },
  }) as Messages

  assert.equal(merged.errors.session_not_found, 'gone')
  // Sibling key in the same group is untouched.
  assert.equal(merged.errors.guild_only, DEFAULT_MESSAGES.errors.guild_only)
  // Other groups are untouched.
  assert.equal(merged.plan.approve_button, DEFAULT_MESSAGES.plan.approve_button)
})

test('deepMergeMessages layers overrides in precedence order', () => {
  // Mimics: defaults <- global <- channel <- role
  const merged = deepMergeMessages(
    DEFAULT_MESSAGES,
    { plan: { approve_button: 'global' } },
    { plan: { approve_button: 'channel' } },
    { plan: { reject_button: 'role-reject' } },
  ) as Messages

  assert.equal(merged.plan.approve_button, 'channel') // later layer wins
  assert.equal(merged.plan.reject_button, 'role-reject') // independent key from another layer
})

test('deepMergeMessages ignores undefined overrides and does not mutate the base', () => {
  const before = DEFAULT_MESSAGES.errors.guild_only
  const merged = deepMergeMessages(DEFAULT_MESSAGES, {
    errors: { guild_only: undefined },
  }) as Messages

  assert.equal(merged.errors.guild_only, before)
  assert.equal(DEFAULT_MESSAGES.errors.guild_only, before) // base untouched
})
