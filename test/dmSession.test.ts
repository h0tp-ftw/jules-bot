import { test } from 'node:test'
import assert from 'node:assert/strict'
import './_ensureDb.js'
import { JulesClient } from '../src/lib/jules/JulesClient.js'
import { julesApiClient } from '../src/lib/jules/JulesClient.js'

test('createSession includes agents and soul personas by default', async () => {
  let capturedConfig: any = null
  const origSession = julesApiClient.session
  julesApiClient.session = (async (config: any) => {
    capturedConfig = config
    return { id: 'test-sess-1' }
  }) as any

  try {
    await JulesClient.createSession({
      prompt: 'Hello Jules',
      repo: 'test/repo',
    })

    assert.ok(capturedConfig)
    assert.match(capturedConfig.prompt, /Agent Personality and Guidelines:/)
    assert.match(capturedConfig.prompt, /Agent Soul and Principles:/)
    assert.match(capturedConfig.prompt, /Hello Jules/)
    assert.deepEqual(capturedConfig.source, { github: 'test/repo', baseBranch: 'main' })
  } finally {
    julesApiClient.session = origSession
  }
})

test('createSession with omitPersonas omits agent and soul personas and runs repoless with NO_CODEBASE', async () => {
  let capturedConfig: any = null
  const origSession = julesApiClient.session
  julesApiClient.session = (async (config: any) => {
    capturedConfig = config
    return { id: 'test-sess-dm' }
  }) as any

  try {
    await JulesClient.createSession({
      prompt: 'Direct conversation prompt',
      repo: 'NO_CODEBASE',
      omitPersonas: true,
      title: 'DM: testuser',
    })

    assert.ok(capturedConfig)
    // Verify NO personas are in the prompt
    assert.doesNotMatch(capturedConfig.prompt, /Agent Personality and Guidelines:/)
    assert.doesNotMatch(capturedConfig.prompt, /Agent Soul and Principles:/)
    assert.match(capturedConfig.prompt, /Direct conversation prompt/)
    // Verify repoless mode (no source config)
    assert.equal(capturedConfig.source, undefined)
    assert.equal(capturedConfig.title, 'DM: testuser')
  } finally {
    julesApiClient.session = origSession
  }
})
