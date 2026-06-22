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
