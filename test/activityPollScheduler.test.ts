import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JulesRateLimitError } from '@google/jules-sdk'
import {
  ActivityPollScheduler,
  isJulesRateLimitError,
  type ActivityPollSchedulerConfig,
} from '../src/lib/jules/ActivityPollScheduler.js'

const config: ActivityPollSchedulerConfig = {
  active_interval_ms: 5,
  idle_interval_ms: 5,
  idle_timeout_ms: 25,
  max_concurrency: 1,
  min_request_spacing_ms: 1,
  rate_limit_base_delay_ms: 10,
  rate_limit_max_delay_ms: 20,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('recognizes Jules rate-limit errors', () => {
  assert.equal(
    isJulesRateLimitError(
      new JulesRateLimitError(
        'https://jules.googleapis.com/v1alpha/sessions/1/activities',
        429,
        'Too Many Requests',
      ),
    ),
    true,
  )
  assert.equal(isJulesRateLimitError(new Error('ordinary failure')), false)
})

test('idle watchers expire and a wake returns them to the active lane', async () => {
  const scheduler = new ActivityPollScheduler(config)
  scheduler.register('thread-1')
  scheduler.markIdle('thread-1')

  assert.equal(scheduler.getMode('thread-1'), 'idle')
  const first = await scheduler.poll('thread-1', async () => 'first')
  assert.deepEqual(first, { expired: false, value: 'first' })

  scheduler.wake('thread-1')
  assert.equal(scheduler.getMode('thread-1'), 'active')
  assert.equal(scheduler.getIdleSince('thread-1'), null)

  scheduler.markIdle('thread-1')
  await sleep(config.idle_timeout_ms + 10)
  const expired = await scheduler.poll('thread-1', async () => 'should-not-run')
  assert.deepEqual(expired, { expired: true })
})

test('a 429 creates one shared cooldown and the scheduled poll retries automatically', async () => {
  const scheduler = new ActivityPollScheduler(config, Date.now, () => 0)
  scheduler.register('thread-1')

  let attempts = 0
  const startedAt = Date.now()
  const result = await scheduler.poll('thread-1', async () => {
    attempts++
    if (attempts === 1) {
      throw new JulesRateLimitError(
        'https://jules.googleapis.com/v1alpha/sessions/1/activities',
        429,
        'Too Many Requests',
      )
    }
    return 'ok'
  })

  assert.deepEqual(result, { expired: false, value: 'ok' })
  assert.equal(attempts, 2)
  assert.ok(Date.now() - startedAt >= config.rate_limit_base_delay_ms - 2)
})

test('the global request spacing smooths simultaneous due polls', async () => {
  const scheduler = new ActivityPollScheduler({
    ...config,
    max_concurrency: 2,
    min_request_spacing_ms: 10,
  })
  scheduler.register('thread-a')
  scheduler.register('thread-b')

  const starts: number[] = []
  const operation = async () => {
    starts.push(Date.now())
    return 'ok'
  }

  await Promise.all([scheduler.poll('thread-a', operation), scheduler.poll('thread-b', operation)])
  starts.sort((a, b) => a - b)
  assert.ok(starts[1] - starts[0] >= 8)
})

test('the global concurrency ceiling serializes network polls', async () => {
  const scheduler = new ActivityPollScheduler(config)
  scheduler.register('thread-a')
  scheduler.register('thread-b')

  let inFlight = 0
  let maxInFlight = 0
  const operation = async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await sleep(12)
    inFlight--
    return 'ok'
  }

  await Promise.all([scheduler.poll('thread-a', operation), scheduler.poll('thread-b', operation)])
  assert.equal(maxInFlight, 1)
})
