import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractReactionMarkers } from '../src/lib/utils/reactionMarkers.js'

test('returns the input unchanged and no emojis when there are no markers', () => {
  const { text, emojis } = extractReactionMarkers('just a normal reply')
  assert.equal(text, 'just a normal reply')
  assert.deepEqual(emojis, [])
})

test('returns empty input untouched', () => {
  assert.deepEqual(extractReactionMarkers(''), { text: '', emojis: [] })
})

test('extracts a single unicode marker and strips it from the text', () => {
  const { text, emojis } = extractReactionMarkers('Nice work [[react:👍]]')
  assert.equal(text, 'Nice work')
  assert.deepEqual(emojis, ['👍'])
})

test('removes an inline marker without leaving a double space', () => {
  const { text, emojis } = extractReactionMarkers('Great [[react:🎉]] job')
  assert.equal(text, 'Great job')
  assert.deepEqual(emojis, ['🎉'])
})

test('collects multiple markers in order', () => {
  const { text, emojis } = extractReactionMarkers('done [[react:✅]] [[react:🚀]]')
  assert.equal(text, 'done')
  assert.deepEqual(emojis, ['✅', '🚀'])
})

test('a message that is only a marker yields empty text', () => {
  const { text, emojis } = extractReactionMarkers('[[react:👀]]')
  assert.equal(text, '')
  assert.deepEqual(emojis, ['👀'])
})

test('preserves custom-emoji payloads verbatim for the caller to resolve', () => {
  assert.deepEqual(extractReactionMarkers('hi [[react:<:blob:123>]]').emojis, ['<:blob:123>'])
  assert.deepEqual(extractReactionMarkers('hi [[react:name:123]]').emojis, ['name:123'])
  assert.deepEqual(extractReactionMarkers('hi [[react::party:]]').emojis, [':party:'])
})

test('is case-insensitive and tolerant of inner whitespace', () => {
  assert.deepEqual(extractReactionMarkers('[[REACT: 👍 ]]').emojis, ['👍'])
  assert.deepEqual(extractReactionMarkers('[[ react :🎉]]').emojis, ['🎉'])
})

test('a marker on its own line does not leave a big blank gap', () => {
  const { text, emojis } = extractReactionMarkers('Line one\n[[react:🎉]]\nLine two')
  assert.equal(text, 'Line one\n\nLine two')
  assert.deepEqual(emojis, ['🎉'])
})

test('preserves intentional indentation/whitespace in the body', () => {
  const input = 'Here:\n```\n  indented  code\n```\n[[react:✅]]'
  const { text, emojis } = extractReactionMarkers(input)
  assert.equal(text, 'Here:\n```\n  indented  code\n```')
  assert.deepEqual(emojis, ['✅'])
})
