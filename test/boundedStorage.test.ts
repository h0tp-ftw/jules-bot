import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BoundedMemoryStorage,
  BoundedSessionStorage,
  evictSessionStorage,
  memoryStorageFactory,
} from '../src/lib/jules/JulesClient.js'

test('BoundedMemoryStorage caps stored activities and prunes oldest', async () => {
  const storage = new BoundedMemoryStorage()
  for (let i = 0; i < 250; i++) {
    await storage.append({ id: `act-${i}`, createTime: new Date(1000 + i).toISOString() })
  }

  // Oldest should have been pruned (exceeded 200)
  assert.equal(await storage.get('act-0'), undefined)
  assert.equal(await storage.get('act-49'), undefined)

  // Recent ones should exist
  assert.notEqual(await storage.get('act-50'), undefined)
  assert.notEqual(await storage.get('act-249'), undefined)

  const latest = await storage.latest()
  assert.equal(latest?.id, 'act-249')

  let count = 0
  for await (const act of storage.scan()) {
    count++
  }
  assert.equal(count, 200)
})

test('BoundedSessionStorage caps stored sessions and allows eviction', async () => {
  const sessionStorage = new BoundedSessionStorage()
  for (let i = 0; i < 60; i++) {
    await sessionStorage.upsert({ id: `sess-${i}`, title: `Session ${i}`, state: 'inProgress' })
  }

  // Oldest should have been evicted (limit is 50)
  assert.equal(await sessionStorage.get('sess-0'), undefined)
  assert.notEqual(await sessionStorage.get('sess-59'), undefined)

  await sessionStorage.delete('sess-59')
  assert.equal(await sessionStorage.get('sess-59'), undefined)
})

test('evictSessionStorage cleans up both activity storage and session storage', async () => {
  const activityStorage = memoryStorageFactory.activity('sess-cleanup-test')
  await activityStorage.append({ id: 'act-1' })
  assert.notEqual(await activityStorage.get('act-1'), undefined)

  await memoryStorageFactory.session().upsert({ id: 'sess-cleanup-test', title: 'Test' })
  assert.notEqual(await memoryStorageFactory.session().get('sess-cleanup-test'), undefined)

  evictSessionStorage('sess-cleanup-test')

  // Closed activity storage should have empty activities
  assert.equal(await activityStorage.get('act-1'), undefined)
  assert.equal(await memoryStorageFactory.session().get('sess-cleanup-test'), undefined)
})
