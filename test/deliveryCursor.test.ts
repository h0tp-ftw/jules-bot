import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import './_ensureDb.js'
import { prisma } from '../src/config.js'
import {
  getActivityDate,
  initializeProcessedActivityIds,
  persistDeliveredActivity,
} from '../src/lib/jules/deliveryCursor.js'

// Characterization tests for the delivery-cursor module. These pin the current
// cursor semantics (restore-from-cursor, legacy Discord-baseline bootstrap,
// at-least-once persistence) so the upcoming refactors cannot silently change
// replay/dedup behavior. Uses real prisma against dev.db with uniquely-prefixed
// threadIds, cleaned up below.
const PREFIX = 'dc-test-'
afterEach(async () => {
  await prisma.debugSession.deleteMany({ where: { threadId: { startsWith: PREFIX } } })
})

function makeSession(activities: any[], hydrateCount = 0) {
  let hydrateCalls = 0
  return {
    hydrateCalls: () => hydrateCalls,
    activities: {
      hydrate: async () => {
        hydrateCalls++
        return hydrateCount
      },
      select: async () => activities,
    },
  }
}

test('getActivityDate parses ISO createTime and rejects junk', () => {
  assert.equal(
    getActivityDate({ createTime: '2026-01-02T03:04:05.000Z' })?.getTime(),
    Date.UTC(2026, 0, 2, 3, 4, 5),
  )
  assert.equal(getActivityDate({ createTime: 'not-a-date' }), null)
  assert.equal(getActivityDate({}), null)
  assert.equal(getActivityDate(null), null)
})

test('initializeProcessedActivityIds trusts a provided initial skip set', async () => {
  const activities = [
    { id: 'a1', type: 'agentMessaged', message: 'done', createTime: '2026-01-01T00:00:01Z' },
    {
      id: 'a2',
      type: 'userMessaged',
      userMessaged: { message: '[Message details - Author Nickname: x]' },
      createTime: '2026-01-01T00:00:02Z',
    },
  ]
  const session = makeSession(activities)
  const thread: any = { id: `${PREFIX}provided`, client: { user: { id: 'bot-1' } } }

  const res = await initializeProcessedActivityIds(session, 'sess-x', thread, new Set(['a1']))

  assert.deepEqual([...res.ids].sort(), ['a1'])
  assert.equal(res.hydrated, true)
  assert.ok(session.hydrateCalls() >= 1, 'history hydration ran once')
  // Only PROCESSED activities feed the derived turn state (pinned semantics).
  assert.deepEqual(res.turnState, { awaitingAgentReply: false })
})

test('a persisted cursor restores every activity up to the last delivered id', async () => {
  const threadId = `${PREFIX}cursor`
  await prisma.debugSession.create({
    data: {
      threadId,
      julesSessionId: 'sess-cursor',
      guildId: 'guild-test',
      repoName: 'test/repo',
      deliveryCursorInitialized: true,
      lastDeliveredActivityId: 'a2',
      lastDeliveredActivityAt: new Date('2026-01-01T00:00:02Z'),
    },
  })
  const activities = [
    { id: 'a1', type: 'agentMessaged', message: 'x', createTime: '2026-01-01T00:00:01Z' },
    { id: 'a2', type: 'agentMessaged', message: 'y', createTime: '2026-01-01T00:00:02Z' },
    { id: 'a3', type: 'agentMessaged', message: 'z', createTime: '2026-01-01T00:00:03Z' },
  ]
  const thread: any = { id: threadId, client: { user: { id: 'bot-1' } } }

  const res = await initializeProcessedActivityIds(makeSession(activities), 'sess-cursor', thread)

  assert.deepEqual([...res.ids].sort(), ['a1', 'a2'], 'activities up to cursor are skipped')
  assert.deepEqual(res.turnState, { awaitingAgentReply: false })
})

test('legacy sessions baseline from the newest posted bot message and persist a cursor', async () => {
  const threadId = `${PREFIX}legacy`
  await prisma.debugSession.create({
    data: {
      threadId,
      julesSessionId: 'sess-legacy',
      guildId: 'guild-test',
      repoName: 'test/repo',
      deliveryCursorInitialized: false,
    },
  })
  const t1 = Date.UTC(2026, 0, 1, 0, 0, 1)
  const t2 = Date.UTC(2026, 0, 1, 0, 0, 2)
  const t3 = Date.UTC(2026, 0, 1, 0, 0, 3)
  const botMessageTs = t2
  const thread: any = {
    id: threadId,
    client: { user: { id: 'bot-1' } },
    messages: {
      fetch: async () => ({
        values: () => [{ author: { id: 'bot-1' }, createdTimestamp: botMessageTs }],
      }),
    },
  }
  const mk = (id: string, ts: number) => ({
    id,
    type: 'progressUpdated',
    createTime: new Date(ts).toISOString(),
  })
  const res = await initializeProcessedActivityIds(
    makeSession([mk('a1', t1), mk('a2', t2), mk('a3', t3)]),
    'sess-legacy',
    thread,
  )

  assert.deepEqual(
    [...res.ids].sort(),
    ['a1', 'a2'],
    'activities older than the bot message are treated as delivered',
  )

  const row = await prisma.debugSession.findUnique({ where: { threadId } })
  assert.equal(row!.deliveryCursorInitialized, true)
  assert.equal(row!.lastDeliveredActivityId, 'a2')
})

test('persistDeliveredActivity records the cursor and survives a missing row', async () => {
  const threadId = `${PREFIX}persist`
  await prisma.debugSession.create({
    data: {
      threadId,
      julesSessionId: 'sess-persist',
      guildId: 'guild-test',
      repoName: 'test/repo',
      deliveryCursorInitialized: false,
    },
  })

  const activity = { id: 'act-9', createTime: '2026-01-01T00:00:09Z' }
  await persistDeliveredActivity(threadId, activity)
  const row = await prisma.debugSession.findUnique({ where: { threadId } })
  assert.equal(row!.lastDeliveredActivityId, 'act-9')
  assert.equal(row!.deliveryCursorInitialized, true)

  // Unknown thread: delivery already happened, so this must resolve, not throw.
  await persistDeliveredActivity(`${PREFIX}missing`, activity)
})
