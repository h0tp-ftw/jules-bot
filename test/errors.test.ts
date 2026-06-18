import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatErrorForDiscord } from '../src/lib/utils/errors.js'

test('prefers the stack of an Error', () => {
  const err = new Error('boom')
  const out = formatErrorForDiscord(err)
  assert.ok(out.includes('boom'))
  // a real stack mentions this test file
  assert.ok(out.includes('Error: boom'))
})

test('falls back to the message when there is no stack', () => {
  const err = new Error('no stack here')
  err.stack = undefined
  assert.equal(formatErrorForDiscord(err), 'no stack here')
})

test('passes through string and stringifies other values', () => {
  assert.equal(formatErrorForDiscord('plain string'), 'plain string')
  assert.equal(formatErrorForDiscord(42), '42')
  assert.equal(formatErrorForDiscord({ toString: () => 'objstr' }), 'objstr')
})

test('returns a placeholder for empty input', () => {
  assert.equal(formatErrorForDiscord(''), 'Unknown error')
})

test('neutralizes backtick runs so they cannot close the code fence', () => {
  const out = formatErrorForDiscord('before ``` after')
  // no run of 3 backticks survives
  assert.ok(!out.includes('```'), `still contains a fence: ${JSON.stringify(out)}`)
  // content is otherwise preserved
  assert.ok(out.includes('before'))
  assert.ok(out.includes('after'))
})

test('caps length with an ellipsis and never exceeds maxLen', () => {
  const out = formatErrorForDiscord('x'.repeat(5000), 1800)
  assert.ok(out.length <= 1800, `length ${out.length} exceeds cap`)
  assert.ok(out.endsWith('…'))
})
