import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logger } from '../src/lib/utils/logger.js'

type Captured = { sink: 'log' | 'warn' | 'error'; args: unknown[] }

// Swap console.{log,warn,error} for capturing stand-ins while `fn` runs.
function capture(fn: () => void): Captured[] {
  const out: Captured[] = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args: unknown[]) => out.push({ sink: 'log', args })
  console.warn = (...args: unknown[]) => out.push({ sink: 'warn', args })
  console.error = (...args: unknown[]) => out.push({ sink: 'error', args })
  try {
    fn()
  } finally {
    Object.assign(console, orig)
  }
  return out
}

function withLevel(level: string | undefined, fn: () => void): Captured[] {
  const prev = process.env.LOG_LEVEL
  if (level === undefined) delete process.env.LOG_LEVEL
  else process.env.LOG_LEVEL = level
  try {
    return capture(fn)
  } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = prev
  }
}

// The message itself is args[1] (args[0] is the injected "[time] [level]" prefix).
const messages = (c: Captured[]) => c.map((e) => e.args[1])

test('info level: debug is suppressed; info/warn/error emit', () => {
  const out = withLevel('info', () => {
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
  })
  assert.deepEqual(messages(out), ['i', 'w', 'e'])
})

test('debug level emits everything, routing debug to console.log', () => {
  const out = withLevel('debug', () => {
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
  })
  assert.deepEqual(
    out.map((e) => e.sink),
    ['log', 'log', 'warn', 'error'],
  )
})

test('warn level suppresses debug + info', () => {
  const out = withLevel('warn', () => {
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
  })
  assert.deepEqual(messages(out), ['w', 'e'])
})

test('error level emits only errors', () => {
  const out = withLevel('error', () => {
    logger.info('i')
    logger.warn('w')
    logger.error('e')
  })
  assert.deepEqual(messages(out), ['e'])
})

test('an unrecognized LOG_LEVEL falls back to info', () => {
  const out = withLevel('verbose', () => {
    logger.debug('d')
    logger.info('i')
  })
  assert.deepEqual(messages(out), ['i'])
})

test('an unset LOG_LEVEL defaults to info', () => {
  const out = withLevel(undefined, () => {
    logger.debug('d')
    logger.info('i')
  })
  assert.deepEqual(messages(out), ['i'])
})

test('LOG_LEVEL is case-insensitive', () => {
  const out = withLevel('ERROR', () => {
    logger.info('i')
    logger.error('e')
  })
  assert.deepEqual(messages(out), ['e'])
})

test('each line is prefixed with an ISO timestamp + level tag', () => {
  const out = withLevel('debug', () => logger.warn('msg'))
  assert.equal(out.length, 1)
  assert.match(
    out[0].args[0] as string,
    /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[warn\]$/,
  )
  assert.equal(out[0].args[1], 'msg')
})

test('the threshold is read fresh on every call (unaffected by import order)', () => {
  const prev = process.env.LOG_LEVEL
  try {
    const out = capture(() => {
      process.env.LOG_LEVEL = 'error'
      logger.info('hidden')
      process.env.LOG_LEVEL = 'info'
      logger.info('shown')
    })
    assert.deepEqual(messages(out), ['shown'])
  } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = prev
  }
})

test('multiple arguments are forwarded after the prefix', () => {
  const err = new Error('boom')
  const out = withLevel('info', () => logger.error('context:', err))
  assert.equal(out.length, 1)
  assert.equal(out[0].args[1], 'context:')
  assert.equal(out[0].args[2], err)
})
