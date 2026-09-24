import { test } from 'node:test'
import assert from 'node:assert/strict'
import './_ensureDb.js'
import { VirtualDiscordChannel, VirtualDiscordMessage } from '../src/harness/virtualChannel.js'
import { getEffectiveConfig } from '../src/config.js'
import { deliverWithReply } from '../src/lib/utils/replyDelivery.js'
import { createHarnessHttpServer } from '../src/harness/harnessServer.js'

test('VirtualDiscordChannel creates messages and manages replies', async () => {
  const channel = new VirtualDiscordChannel({
    id: 'test-chan-1',
    name: 'test-chat',
    guildId: '1241773562629718148',
  })

  let eventFired = false
  channel.on('message', (msg: VirtualDiscordMessage) => {
    if (msg.content === 'Hello from user') {
      eventFired = true
    }
  })

  const userMsg = await channel._addMessage({
    content: 'Hello from user',
    authorId: 'user-123',
    authorUsername: 'Alice',
    isBot: false,
  })

  assert.equal(eventFired, true)
  assert.equal(userMsg.content, 'Hello from user')
  assert.equal(userMsg.author.username, 'Alice')
  assert.equal(userMsg.author.bot, false)

  // Test reply
  const replyMsg = await userMsg.reply('Hello Alice, I am Jules!')
  assert.equal(replyMsg.content, 'Hello Alice, I am Jules!')
  assert.equal(replyMsg.author.bot, true)
  assert.equal(replyMsg.reference?.messageId, userMsg.id)

  // Test reaction
  await userMsg.react('👍')
  assert.deepEqual(userMsg.reactionsApplied, ['👍'])

  // Test starter message fetch
  const starter = await channel.fetchStarterMessage()
  assert.equal(starter?.id, userMsg.id)
})

test('VirtualDiscordChannel is compatible with getEffectiveConfig', async () => {
  const channel = new VirtualDiscordChannel({
    id: '1518976506460897280', // Peace channel in config.yaml
    guildId: '1241773562629718148',
  })

  const cfg = getEffectiveConfig(channel)
  // Channel 1518976506460897280 specifies default_repo: 'h0tp-ftw/onigiri'
  assert.equal(cfg.default_repo, 'h0tp-ftw/onigiri')
  assert.match(cfg.agents_personality || '', /You are a blackbox/)
})

test('VirtualDiscordChannel is compatible with deliverWithReply', async () => {
  const channel = new VirtualDiscordChannel({
    id: 'test-chan-2',
    name: 'test-chat',
  })

  const userMsg = await channel._addMessage({
    content: 'Ping',
    authorId: 'user-123',
  })

  const sent = await deliverWithReply(channel, userMsg, 'reply_ping', {
    content: 'Pong',
  })

  assert.equal(sent.content, 'Pong')
  assert.equal(sent.reference?.messageId, userMsg.id)
  assert.equal(channel.getAllMessages().length, 2)
})

test('Harness HTTP server handles health endpoint', async () => {
  const server = createHarnessHttpServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as any
  const port = addr.port

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.status, 'ok')
    assert.equal(typeof json.activeSessions, 'number')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
