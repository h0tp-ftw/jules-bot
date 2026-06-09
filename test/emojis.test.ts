import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMessageEmojis } from '../src/lib/utils/emojis.js'

// Minimal stand-in for the discord.js client: only emojis.cache.find is used,
// which behaves like Array.prototype.find.
function mockClient(emojis: { name: string; id: string; animated?: boolean }[]): any {
  return {
    emojis: {
      cache: {
        find: (fn: (e: any) => boolean) => emojis.find(fn),
      },
    },
  }
}

test('returns the input unchanged when text is empty', () => {
  assert.equal(resolveMessageEmojis(mockClient([]), ''), '')
})

test('rewrites a full custom-emoji tag to the locally cached id', () => {
  const client = mockClient([{ name: 'blob', id: '999' }])
  assert.equal(resolveMessageEmojis(client, '<:blob:111>'), '<:blob:999>')
})

test('rewrites an animated custom-emoji tag with the a: prefix', () => {
  const client = mockClient([{ name: 'wave', id: '42', animated: true }])
  assert.equal(resolveMessageEmojis(client, '<a:wave:1>'), '<a:wave:42>')
})

test('does not mangle a full tag whose name is also a known shortcode', () => {
  // Regression: the shortcode pass used to re-match ":blob:" inside the
  // already-resolved <:blob:999> tag, producing nested garbage.
  const client = mockClient([{ name: 'blob', id: '999' }])
  const out = resolveMessageEmojis(client, 'see <:blob:111> here')
  assert.equal(out, 'see <:blob:999> here')
})

test('resolves a :shortcode: that matches a cached custom emoji', () => {
  const client = mockClient([{ name: 'party', id: '7' }])
  assert.equal(resolveMessageEmojis(client, 'hi :party:'), 'hi <:party:7>')
})

test('leaves :shortcode: untouched when no custom emoji matches (unicode aliases)', () => {
  assert.equal(resolveMessageEmojis(mockClient([]), 'I :heart: this'), 'I :heart: this')
})

test('keeps the original tag when the referenced emoji is not cached', () => {
  assert.equal(resolveMessageEmojis(mockClient([]), '<:unknown:123>'), '<:unknown:123>')
})
