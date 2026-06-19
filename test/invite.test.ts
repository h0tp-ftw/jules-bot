import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inviteUrl, INVITE_PERMISSIONS } from '../scripts/lib/invite.js'

// The permission bitfield is hand-assembled from individual Discord permission
// bits, so pin its value — a wrong number silently produces a broken invite link
// (bot joins without the permissions it needs).
test('INVITE_PERMISSIONS is the documented bitfield', () => {
  // ADD_REACTIONS | VIEW_CHANNEL | SEND_MESSAGES | MANAGE_MESSAGES | EMBED_LINKS
  // | READ_MESSAGE_HISTORY | USE_APPLICATION_COMMANDS | SEND_MESSAGES_IN_THREADS
  assert.equal(INVITE_PERMISSIONS.toString(), '277025483840')
})

test('inviteUrl carries client_id, permissions, and both required scopes', () => {
  const url = inviteUrl('123456789012345678')
  const parsed = new URL(url)
  assert.equal(parsed.origin + parsed.pathname, 'https://discord.com/oauth2/authorize')
  assert.equal(parsed.searchParams.get('client_id'), '123456789012345678')
  assert.equal(parsed.searchParams.get('permissions'), '277025483840')
  assert.equal(parsed.searchParams.get('scope'), 'bot applications.commands')
})
