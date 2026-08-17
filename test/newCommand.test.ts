import { test } from 'node:test'
import assert from 'node:assert/strict'
import newCmd from '../src/commands/new.js'
import { DEFAULT_MESSAGES } from '../src/strings.js'

test('new slash command has valid name and description', () => {
  const data = newCmd.data.toJSON()
  assert.equal(data.name, 'new')
  assert.equal(data.description, DEFAULT_MESSAGES.commands.new_description)
  assert.equal(data.options?.length, 1)
  assert.equal(data.options?.[0].name, 'prompt')
  assert.equal(data.options?.[0].required, false)
})

test('new slash command rejects execution outside guilds', async () => {
  let replyContent = ''
  let replyEphemeral = false

  const fakeInteraction: any = {
    guildId: null,
    reply: async (payload: any) => {
      replyContent = payload.content
      replyEphemeral = payload.ephemeral
    },
  }

  await newCmd.execute(fakeInteraction, {} as any)
  assert.equal(replyContent, DEFAULT_MESSAGES.errors.guild_only)
  assert.equal(replyEphemeral, true)
})
