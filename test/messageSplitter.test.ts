import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitMessage } from '../src/lib/utils/messageSplitter.js'

test('returns a single chunk when text is under the limit', () => {
  assert.deepEqual(splitMessage('hello', 2000), ['hello'])
})

test('returns the text as-is when exactly at the limit', () => {
  const text = 'a'.repeat(2000)
  assert.deepEqual(splitMessage(text, 2000), [text])
})

test('hard-splits text with no newline and loses no data', () => {
  const text = 'b'.repeat(2500)
  const chunks = splitMessage(text, 2000)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].length, 2000)
  assert.equal(chunks[1].length, 500)
  assert.equal(chunks.join(''), text)
})

test('every chunk stays within the limit for very long input', () => {
  const text = 'a'.repeat(9000)
  for (const c of splitMessage(text, 2000)) {
    assert.ok(c.length <= 2000, `chunk length ${c.length} exceeds limit`)
  }
})

test('prefers splitting on newline boundaries', () => {
  const line = 'x'.repeat(100)
  const text = Array.from({ length: 50 }, () => line).join('\n') // ~5049 chars
  const chunks = splitMessage(text, 2000)
  assert.ok(chunks.length > 1)
  for (const c of chunks) {
    assert.ok(c.length <= 2000, `chunk too long: ${c.length}`)
    assert.ok(c.length > 0, 'unexpected empty chunk')
    // splits land on newlines, so each line inside a chunk is intact
    for (const l of c.split('\n')) assert.equal(l, line)
  }
})

test('never emits an empty chunk when text begins with a newline', () => {
  const text = '\n' + 'a'.repeat(2500)
  const chunks = splitMessage(text, 2000)
  for (const c of chunks) assert.notEqual(c.length, 0)
})
