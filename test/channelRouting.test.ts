import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isConfiguredThreadParent } from '../src/lib/utils/channelRouting.js'

test('accepts the guild forum parent', () => {
  assert.equal(isConfiguredThreadParent('forum-1', 'forum-1', {}), true)
})

test('accepts an explicitly configured parent channel', () => {
  assert.equal(
    isConfiguredThreadParent('forum-2', 'forum-1', {
      'forum-2': { default_repo: 'owner/repo' },
    }),
    true,
  )
})

test('rejects unrelated thread parents', () => {
  assert.equal(isConfiguredThreadParent('general', 'forum-1', { 'forum-2': {} }), false)
})

test('rejects threads without a parent', () => {
  assert.equal(isConfiguredThreadParent(null, 'forum-1', {}), false)
})
