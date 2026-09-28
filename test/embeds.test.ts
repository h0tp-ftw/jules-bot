import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSystemEmbed,
  SYSTEM_EMBED_COLORS,
  SYSTEM_EMBED_DEFAULT_TITLES,
} from '../src/lib/utils/embeds.js'

test('createSystemEmbed sets appropriate default colors and titles per type', () => {
  const errorEmbed = createSystemEmbed('error', { description: 'Something failed' })
  assert.equal(errorEmbed.data.color, SYSTEM_EMBED_COLORS.error)
  assert.equal(errorEmbed.data.title, SYSTEM_EMBED_DEFAULT_TITLES.error)
  assert.equal(errorEmbed.data.description, 'Something failed')

  const warnEmbed = createSystemEmbed('warning', { description: 'Please be advised' })
  assert.equal(warnEmbed.data.color, SYSTEM_EMBED_COLORS.warning)
  assert.equal(warnEmbed.data.title, SYSTEM_EMBED_DEFAULT_TITLES.warning)

  const successEmbed = createSystemEmbed('success', { description: 'PR opened' })
  assert.equal(successEmbed.data.color, SYSTEM_EMBED_COLORS.success)
  assert.equal(successEmbed.data.title, SYSTEM_EMBED_DEFAULT_TITLES.success)

  const infoEmbed = createSystemEmbed('info', { description: 'FYI' })
  assert.equal(infoEmbed.data.color, SYSTEM_EMBED_COLORS.info)
  assert.equal(infoEmbed.data.title, SYSTEM_EMBED_DEFAULT_TITLES.info)
})

test('createSystemEmbed respects custom title, footer, and fields', () => {
  const customEmbed = createSystemEmbed('error', {
    title: '⚠️ Access Denied',
    description: 'You do not have access.',
    footer: 'Session ID: 12345',
    fields: [{ name: 'Reason', value: 'Role mismatch' }],
  })

  assert.equal(customEmbed.data.title, '⚠️ Access Denied')
  assert.equal(customEmbed.data.description, 'You do not have access.')
  assert.equal(customEmbed.data.footer?.text, 'Session ID: 12345')
  assert.deepEqual(customEmbed.data.fields, [{ name: 'Reason', value: 'Role mismatch' }])
})
