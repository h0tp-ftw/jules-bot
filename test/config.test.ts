import { test } from 'node:test'
import assert from 'node:assert/strict'
import './_ensureDb.js' // must precede the config import (see file comment)
import { getEffectiveConfig, yamlConfig, YAML_GUILDS, REACTIONS, MESSAGES } from '../src/config.js'

// getEffectiveConfig layers: global YAML -> parent channel -> thread -> role.
// Channel/thread overrides come from yamlConfig.channels[id]; role overrides
// from yamlConfig.roles[name] matched against the member. Register fixtures by
// mutating those (read at call time) with unique ids so cases don't interfere.
function chan(id: string, override: Record<string, unknown>) {
  yamlConfig.channels = yamlConfig.channels || {}
  yamlConfig.channels[id] = override
}
function role(name: string, override: Record<string, unknown>) {
  yamlConfig.roles = yamlConfig.roles || {}
  yamlConfig.roles[name] = override
}
// Tag overrides come from yamlConfig.tags[nameOrId], matched against a thread's
// applied forum tags. Register fixtures the same way as channels/roles.
function tag(nameOrId: string, override: Record<string, unknown>) {
  yamlConfig.tags = yamlConfig.tags || {}
  yamlConfig.tags[nameOrId] = override
}
// thread carrying applied forum tags (by id). `availableTags` on the parent
// forum lets the resolver match config keyed by tag *name* too.
const threadWithTags = (id: string, appliedTags: string[], extra: Record<string, unknown> = {}) =>
  ({ id, appliedTags, ...extra }) as any
// member whose role set matches `name` (GuildMember-shaped cache).
const memberWithRole = (name: string) =>
  ({
    roles: {
      cache: {
        has: (_k: string) => false,
        some: (fn: (r: any) => boolean) => [{ id: 'rid', name }].some(fn),
      },
    },
  }) as any

test('a thread override beats its parent channel; parent fills the gaps', () => {
  chan('p1', { bot_emoji: 'P', diagnostic_prompt: 'PARENT-PROMPT' })
  chan('t1', { bot_emoji: 'T' })
  const cfg = getEffectiveConfig({ id: 't1', parentId: 'p1' })
  assert.equal(cfg.bot_emoji, 'T') // thread wins where both set it
  assert.equal(cfg.diagnostic_prompt, 'PARENT-PROMPT') // parent applies where thread is silent
})

test('a role override beats the thread; thread fills the gaps', () => {
  chan('t2', { bot_emoji: 'T', diagnostic_prompt: 'THREAD-PROMPT' })
  role('Dev', { bot_emoji: 'R' })
  const cfg = getEffectiveConfig({ id: 't2' }, memberWithRole('Dev'))
  assert.equal(cfg.bot_emoji, 'R') // role wins
  assert.equal(cfg.diagnostic_prompt, 'THREAD-PROMPT') // thread applies where role is silent
})

test('access_control merges per-field across thread and role layers', () => {
  chan('t3', { access_control: { allow_all: false, allowed_users: ['u1'] } })
  role('Admin', { access_control: { allow_all: true } })
  const cfg = getEffectiveConfig({ id: 't3' }, memberWithRole('Admin'))
  assert.equal(cfg.access_control.allow_all, true) // role overrides the boolean
  assert.deepEqual(cfg.access_control.allowed_users, ['u1']) // thread's array is retained
})

test('reactions override only the named stage and keep the rest', () => {
  chan('t4', { reactions: { queued: 'Q!' } })
  const cfg = getEffectiveConfig({ id: 't4' })
  assert.equal(cfg.reactions.queued, 'Q!')
  assert.equal(cfg.reactions.completed, REACTIONS.completed) // untouched stage = global default
})

test('auto_reject is resolved from the thread override', () => {
  chan('t5', { auto_reject: { enabled: true, message: 'revise pls' } })
  const cfg = getEffectiveConfig({ id: 't5' })
  assert.deepEqual(cfg.auto_reject, { enabled: true, message: 'revise pls' })
})

test('jules_reactions defaults off and resolves from thread and role overrides', () => {
  // Default: feature is off when nothing enables it.
  assert.equal(getEffectiveConfig({ id: 'jr-none' }).jules_reactions.enabled, false)
  // Thread override turns it on.
  chan('jr1', { jules_reactions: { enabled: true } })
  assert.equal(getEffectiveConfig({ id: 'jr1' }).jules_reactions.enabled, true)
  // Role override wins over a silent thread.
  role('JrRole', { jules_reactions: { enabled: true } })
  assert.equal(
    getEffectiveConfig({ id: 'jr-none' }, memberWithRole('JrRole')).jules_reactions.enabled,
    true,
  )
})

test('pre_warmed_sessions is resolved from the thread override', () => {
  chan('t6', { pre_warmed_sessions: { enabled: true, pool_size: 5 } })
  const cfg = getEffectiveConfig({ id: 't6' })
  assert.equal(cfg.pre_warmed_sessions.enabled, true)
  assert.equal(cfg.pre_warmed_sessions.pool_size, 5)
})

test('messages deep-merge: an override wins and siblings are preserved', () => {
  chan('t7', { messages: { errors: { guild_only: 'THREAD-ONLY' } } })
  const cfg = getEffectiveConfig({ id: 't7' })
  assert.equal(cfg.messages.errors.guild_only, 'THREAD-ONLY')
  assert.equal(cfg.messages.plan.approve_button, MESSAGES.plan.approve_button) // sibling intact
})

test('with no context the shared MESSAGES object is returned by identity', () => {
  // Hot-path optimization: skip cloning the whole catalog when nothing overrides it.
  const cfg = getEffectiveConfig()
  assert.equal(cfg.messages, MESSAGES)
})

test('default_repo: a thread override beats the DB default', () => {
  chan('t8', { default_repo: 'owner/thread-repo' })
  const cfg = getEffectiveConfig({ id: 't8' }, undefined, 'owner/db-repo')
  assert.equal(cfg.default_repo, 'owner/thread-repo')
})

test('default_repo: a YAML guild mapping beats the DB default', () => {
  YAML_GUILDS['G1'] = { default_repo: 'owner/guild-repo' }
  const cfg = getEffectiveConfig(
    { id: 'cfg-guild-only', guildId: 'G1' },
    undefined,
    'owner/db-repo',
  )
  assert.equal(cfg.default_repo, 'owner/guild-repo')
})

test('default_branch is resolved from the thread override', () => {
  chan('t9', { default_branch: 'develop' })
  const cfg = getEffectiveConfig({ id: 't9' })
  assert.equal(cfg.default_branch, 'develop')
})

test('ignore_prefix and typing_indicator_mode resolve from the thread override', () => {
  chan('t10', { ignore_prefix: '!', typing_indicator_mode: 'always' })
  const cfg = getEffectiveConfig({ id: 't10' })
  assert.equal(cfg.ignore_prefix, '!')
  assert.equal(cfg.typing_indicator_mode, 'always')
})

test('interactive_selection boolean resolves from the thread override', () => {
  chan('t11', { interactive_selection: true })
  assert.equal(getEffectiveConfig({ id: 't11' }).interactive_selection, true)
})

test('an unknown thread id falls back to global defaults without throwing', () => {
  const cfg = getEffectiveConfig({ id: 'never-registered', parentId: 'also-not' })
  assert.equal(typeof cfg.bot_emoji, 'string')
  assert.equal(typeof cfg.access_control.allow_all, 'boolean')
  assert.equal(cfg.messages, MESSAGES) // no overrides => shared catalog
})

test('a tag override is matched against the applied tag id', () => {
  tag('tg-id-1', { bot_emoji: 'X' })
  const cfg = getEffectiveConfig(threadWithTags('tgt1', ['tg-id-1']))
  assert.equal(cfg.bot_emoji, 'X')
})

test('a tag override is matched by name via the parent forum availableTags', () => {
  tag('urgent', { bot_emoji: 'U', diagnostic_prompt: 'URGENT-PROMPT' })
  const cfg = getEffectiveConfig(
    threadWithTags('tgt2', ['snowflake-2'], {
      parent: { availableTags: [{ id: 'snowflake-2', name: 'urgent' }] },
    }),
  )
  assert.equal(cfg.bot_emoji, 'U')
  assert.equal(cfg.diagnostic_prompt, 'URGENT-PROMPT')
})

test('a tag override beats its parent channel; parent fills the gaps', () => {
  chan('tgp3', { bot_emoji: 'P', diagnostic_prompt: 'PARENT-PROMPT' })
  tag('tg3', { bot_emoji: 'TAG' })
  const cfg = getEffectiveConfig(threadWithTags('tgt3', ['tg3'], { parentId: 'tgp3' }))
  assert.equal(cfg.bot_emoji, 'TAG') // tag wins over the channel-wide override
  assert.equal(cfg.diagnostic_prompt, 'PARENT-PROMPT') // parent applies where tag is silent
})

test('a thread override beats the tag; tag fills the gaps', () => {
  chan('tgt4', { bot_emoji: 'T' }) // thread-id override
  tag('tg4', { bot_emoji: 'TAG', diagnostic_prompt: 'TAG-PROMPT' })
  const cfg = getEffectiveConfig(threadWithTags('tgt4', ['tg4']))
  assert.equal(cfg.bot_emoji, 'T') // specific thread wins over the tag
  assert.equal(cfg.diagnostic_prompt, 'TAG-PROMPT') // tag applies where thread is silent
})

test('a role override beats the tag; tag fills the gaps', () => {
  tag('tg5', { bot_emoji: 'TAG', diagnostic_prompt: 'TAG-PROMPT' })
  role('TagRole', { bot_emoji: 'R' })
  const cfg = getEffectiveConfig(threadWithTags('tgt5', ['tg5']), memberWithRole('TagRole'))
  assert.equal(cfg.bot_emoji, 'R') // role wins
  assert.equal(cfg.diagnostic_prompt, 'TAG-PROMPT') // tag applies where role is silent
})

test('multiple applied tags merge in config order; later keys win', () => {
  tag('tgA', { bot_emoji: 'A', diagnostic_prompt: 'FROM-A' })
  tag('tgB', { bot_emoji: 'B' })
  const cfg = getEffectiveConfig(threadWithTags('tgt6', ['tgA', 'tgB']))
  assert.equal(cfg.bot_emoji, 'B') // tgB registered after tgA, so it wins the shared key
  assert.equal(cfg.diagnostic_prompt, 'FROM-A') // tgA's unique key survives the merge
})

test('access_control merges per-field across tag and thread layers', () => {
  chan('tgt8', { access_control: { allowed_users: ['u1'] } }) // thread-id override
  tag('tg8', { access_control: { allow_all: true } })
  const cfg = getEffectiveConfig(threadWithTags('tgt8', ['tg8']))
  assert.equal(cfg.access_control.allow_all, true) // from the tag
  assert.deepEqual(cfg.access_control.allowed_users, ['u1']) // thread's array retained
})

test('a configured tag that is not applied to the thread has no effect', () => {
  tag('tg-unapplied', { bot_emoji: 'Z' })
  const cfg = getEffectiveConfig(threadWithTags('tgt7', ['some-other-tag']))
  assert.notEqual(cfg.bot_emoji, 'Z') // unmatched tag never applies
})

test('tag messages deep-merge between parent and thread layers', () => {
  tag('tg-msg', { messages: { errors: { guild_only: 'TAG-ONLY' } } })
  const cfg = getEffectiveConfig(threadWithTags('tgt9', ['tg-msg']))
  assert.equal(cfg.messages.errors.guild_only, 'TAG-ONLY')
  assert.equal(cfg.messages.plan.approve_button, MESSAGES.plan.approve_button) // sibling intact
})
