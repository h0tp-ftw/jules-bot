import { test } from 'node:test'
import assert from 'node:assert/strict'
import './_ensureDb.js'
import { prisma } from '../src/config.js'
import { runJulesStream } from '../src/lib/jules/runJulesStream.js'
import {
  activeStreams,
  autoRejectedSessions,
  processedActivityIdsMap,
} from '../src/lib/jules/streamRegistry.js'

// Characterization tests for the session polling loop. Each test drives
// runJulesStream with a scripted fake session (injected via the sessionFactory
// seam), a fake Discord thread, and records every side effect. These pin the
// current delivery/retry/teardown semantics ahead of any handler refactor.
//
// Termination strategy: production keeps polling a warm/idle session for its
// full grace period, so every scenario packs ALL activities into ONE select
// batch whose last entry is a `sessionFailed` activity — that handler returns
// from the loop immediately, so no idle-lane timer ever has to elapse.
//
// Per-run unique prefix so dev.db never carries colliding debugSession rows
// between runs (the planGenerated scenario creates one).

const RUN = Math.random().toString(36).slice(2, 8)
const PREFIX = `rjs-${RUN}-`
let seq = 0

const FAIL = (id: string) => ({ id, type: 'sessionFailed', reason: 'boom' })

const agentMessaged = (id: string, text: string) => ({
  id,
  type: 'agentMessaged',
  message: text,
})

async function makeThread() {
  const id = `${PREFIX}${++seq}`
  // Pre-seed the skip set so runJulesStream bypasses cursor initialization
  // (which performs its own activities.select() and would consume the scripted
  // batch). Cursor-init behavior is covered by deliveryCursor.test.ts.
  processedActivityIdsMap.set(id, new Set())
  // Create the debugSession row so cursor persistence (markActivityProcessed →
  // persistDeliveredActivity) succeeds instead of logging P2025 noise. Cleaned
  // up by afterEach.
  prisma.debugSession
    .create({
      data: {
        threadId: id,
        guildId: 'guild-1',
        repoName: 'test/repo',
        julesSessionId: 'sess-1',
        deliveryCursorInitialized: true,
      },
    })
    .catch(() => {})
  const sent: any[] = []
  const humanMsgs: any[] = []
  const thread: any = {
    id,
    guildId: 'guild-1',
    parentId: undefined,
    appliedTags: [],
    client: {
      user: { id: 'bot-1' },
      emojis: { cache: { get: () => undefined } },
    },
    isThread: () => true,
    archived: false,
    locked: false,
    sendTyping: async () => {},
    send: async (payload: any) => {
      sent.push(payload)
      return { id: `sent-${sent.length}` }
    },
    messages: {
      fetch: async () => ({ values: () => [...humanMsgs] }),
    },
  }

  const addHumanMessage = () => {
    const reactionsApplied: string[] = []
    const replies: any[] = []
    humanMsgs.push({
      id: `hm-${humanMsgs.length}`,
      channel: thread,
      client: thread.client,
      author: { id: `user-${seq}`, bot: false },
      member: undefined,
      createdTimestamp: Date.now(),
      reply: async (payload: any) => {
        replies.push(payload)
        return { id: `r-${replies.length}` }
      },
      react: async (emoji: string) => {
        reactionsApplied.push(emoji)
      },
      reactions: { cache: { values: () => [] } },
    })
    return { msg: humanMsgs[humanMsgs.length - 1], replies, reactionsApplied }
  }

  return { thread, sent, addHumanMessage }
}

function makeSession(script: { infos?: any[]; batch: any[]; result?: any }) {
  const infos = script.infos && script.infos.length > 0 ? script.infos : [{ state: 'inProgress' }]
  let infoIdx = 0
  let selected = false
  const sends: string[] = []
  const hydrateCalls = { count: 0 }
  return {
    id: 'sess-1',
    sends,
    hydrateCalls,
    sessionStorage: { delete: async () => {} },
    info: async () => {
      const next = infoIdx < infos.length ? infos[infoIdx++] : infos[infos.length - 1]
      if (next instanceof Error) throw next
      return next
    },
    send: async (content: string) => {
      sends.push(content)
    },
    result: async () => script.result ?? null,
    activities: {
      hydrate: async () => {
        hydrateCalls.count++
        return 0
      },
      select: async () => {
        if (selected) return []
        selected = true
        return script.batch
      },
    },
  }
}

function makeStreamManager() {
  return {
    handleProgressCalls: [] as any[],
    finalizeCalls: [] as any[],
    async handleProgress(...args: any[]) {
      this.handleProgressCalls.push(args)
    },
    async finalizeSession(...args: any[]) {
      this.finalizeCalls.push(args)
    },
  }
}

// Default reply_mode is `send`, so agent/progress text lands on thread.send
// rather than a target.reply. Assert delivery on whichever channel fired.
function assertDeliveredText(sent: any[], replies: any[], expected: string) {
  const sentText = sent.filter((s) => typeof s === 'string').join('')
  const replyText = replies.map((r) => r.content).join('')
  assert.ok(
    sentText.includes(expected) || replyText.includes(expected),
    `expected "${expected}" delivered; sent="${sentText}" replies="${replyText}"`,
  )
}

test(
  'an agent reply is delivered and stamped responded + failed',
  { timeout: 15_000 },
  async () => {
    const { thread, sent, addHumanMessage } = await makeThread()
    const target = addHumanMessage()
    const streamManager = makeStreamManager()
    const session = makeSession({
      batch: [agentMessaged('act-1', 'here is your answer'), FAIL('act-f')],
    })

    await runJulesStream('sess-1', thread, streamManager as any, undefined, undefined, {
      sessionFactory: () => session,
    })

    assertDeliveredText(sent, target.replies, 'here is your answer')
    assert.ok(
      target.reactionsApplied.length >= 2,
      `responded + failed lifecycle reactions stamped, got ${JSON.stringify(target.reactionsApplied)}`,
    )
    assert.deepEqual(streamManager.finalizeCalls, [[thread.id, false, 'boom']])
    assert.equal(activeStreams.has(thread.id), false, 'stream torn down')
    assert.equal(processedActivityIdsMap.get(thread.id), undefined, 'per-thread state released')
  },
)

test(
  'a failed session state exits without finalizing and without user-facing failure text',
  { timeout: 15_000 },
  async () => {
    const { thread, sent, addHumanMessage } = await makeThread()
    addHumanMessage()
    const streamManager = makeStreamManager()
    const session = makeSession({ infos: [{ state: 'failed' }], batch: [] })

    await runJulesStream('sess-1', thread, streamManager as any, undefined, undefined, {
      sessionFactory: () => session,
    })

    assert.equal(streamManager.finalizeCalls.length, 0, 'state-only failure never finalizes')
    assert.equal(sent.length, 0)
    assert.equal(activeStreams.has(thread.id), false)
  },
)

test(
  'a permanent 404 during the jules phase exits permanently on first attempt',
  { timeout: 15_000 },
  async () => {
    const { thread, sent, addHumanMessage } = await makeThread()
    addHumanMessage()
    const streamManager = makeStreamManager()
    const err = Object.assign(new Error('Not Found'), { status: 404 })
    const session = makeSession({ infos: [err], batch: [] })
    let factoryCalls = 0

    await runJulesStream('sess-1', thread, streamManager as any, undefined, undefined, {
      sessionFactory: () => {
        factoryCalls++
        return session
      },
    })

    assert.equal(factoryCalls, 1, 'no retry after a permanent jules error')
    assert.equal(sent.length, 0)
    assert.equal(streamManager.finalizeCalls.length, 0)
    assert.equal(activeStreams.has(thread.id), false)
  },
)

test('a transient error retries and then keeps delivering', { timeout: 20_000 }, async () => {
  const { thread, sent, addHumanMessage } = await makeThread()
  const target = addHumanMessage()
  const streamManager = makeStreamManager()
  let firstInfoCall = true
  const session = makeSession({ batch: [agentMessaged('act-1', 'recovered'), FAIL('act-f')] })
  session.info = async () => {
    if (firstInfoCall) {
      firstInfoCall = false
      throw new Error('socket hang up')
    }
    return { state: 'inProgress' }
  }

  await runJulesStream('sess-1', thread, streamManager as any, undefined, undefined, {
    sessionFactory: () => session,
  })

  assertDeliveredText(sent, target.replies, 'recovered')
  assert.deepEqual(streamManager.finalizeCalls, [[thread.id, false, 'boom']])
})

test(
  'planGenerated posts approve/reject buttons when no auto-reject applies',
  { timeout: 15_000 },
  async () => {
    const { thread, sent, addHumanMessage } = await makeThread()
    addHumanMessage()
    const threadId = thread.id
    const streamManager = makeStreamManager()
    const session = makeSession({
      infos: [{ state: 'planning' }],
      batch: [
        {
          id: 'act-p',
          type: 'planGenerated',
          plan: { steps: [{ title: 'step one' }, { title: 'step two' }] },
        },
        FAIL('act-f'),
      ],
    })
    // Force the plan-approval path: with auto_reject enabled in the live config
    // the planGenerated handler would otherwise auto-reject and never post
    // approve/reject buttons. Marking the session already-rejected makes the
    // handler skip auto-reject and render the plan.
    autoRejectedSessions.add('sess-1')

    try {
      await runJulesStream('sess-1', thread, streamManager as any, undefined, undefined, {
        sessionFactory: () => session,
      })
    } finally {
      autoRejectedSessions.delete('sess-1')
    }

    assert.equal(sent.length, 1, 'plan posted to the thread (default reply_mode=send)')
    const payload = sent[0]
    assert.ok(payload.embeds?.length === 1, 'plan rendered as an embed')
    const customIds = payload.components[0].components.map((b: any) => b.data.custom_id)
    assert.deepEqual(customIds, [`plan-approve:${threadId}`, `plan-reject:${threadId}`])
  },
)

test(
  'progressUpdated drives the stream manager outside chatbot mode only',
  { timeout: 15_000 },
  async () => {
    const mk = async (chatbotMode: boolean) => {
      const { thread, addHumanMessage } = await makeThread()
      addHumanMessage()
      const streamManager = makeStreamManager()
      const session = makeSession({
        batch: [
          { id: 'act-g', type: 'progressUpdated', title: 'Step 1', description: 'doing things' },
          FAIL('act-f'),
        ],
      })
      await runJulesStream('sess-1', thread, streamManager as any, undefined, undefined, {
        chatbotMode,
        sessionFactory: () => session,
      })
      return streamManager
    }

    const visible = await mk(false)
    assert.equal(visible.handleProgressCalls.length, 1)
    assert.deepEqual(visible.handleProgressCalls[0].slice(1), ['Step 1', 'doing things'])

    const suppressed = await mk(true)
    assert.equal(suppressed.handleProgressCalls.length, 0, 'chatbot mode suppresses progress UI')
  },
)

test(
  'onReady fires once the skip set is populated and before sends are gated',
  { timeout: 15_000 },
  async () => {
    const { thread, addHumanMessage } = await makeThread()
    addHumanMessage()
    const streamManager = makeStreamManager()
    const session = makeSession({ batch: [FAIL('act-f')] })
    let readyCount = 0

    await runJulesStream(
      'sess-1',
      thread,
      streamManager as any,
      undefined,
      () => {
        readyCount++
      },
      {
        sessionFactory: () => session,
      },
    )

    assert.equal(readyCount, 1)
  },
)

test.afterEach(async () => {
  await prisma.debugSession.deleteMany({ where: { threadId: { startsWith: PREFIX } } })
})
