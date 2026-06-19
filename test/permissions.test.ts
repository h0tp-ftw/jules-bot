import { test } from 'node:test'
import assert from 'node:assert/strict'
import './_ensureDb.js' // must precede the config import (see file comment)
import { hasPermission } from '../src/lib/utils/permissions.js'
import { yamlConfig } from '../src/config.js'

// hasPermission resolves access control through getEffectiveConfig, which reads
// yamlConfig.channels[thread.id] at call time. Register a per-thread channel
// override so each case has a fully-determined access_control, independent of
// the repo's own config.yaml. A unique id per call avoids cross-test bleed.
let n = 0
function threadWithAccess(
  ac: Record<string, unknown>,
  opts: { ownerId?: string } = {},
): { id: string; ownerId: string } {
  const id = `perm-test-${n++}`
  yamlConfig.channels = yamlConfig.channels || {}
  yamlConfig.channels[id] = { access_control: ac }
  return { id, ownerId: opts.ownerId ?? 'OWNER' }
}

const closed = { allow_all: false, allowed_users: [] as string[], allowed_roles: [] as string[] }
const userObj = (id: string) => ({ id }) as any
// GuildMember-shaped: roles.cache.some iterates role objects.
const guildMember = (roleIds: string[]) =>
  ({
    roles: { cache: { some: (fn: (r: any) => boolean) => roleIds.map((id) => ({ id })).some(fn) } },
  }) as any
// APIInteractionGuildMember-shaped: roles is a string[].
const apiMember = (roleIds: string[]) => ({ roles: roleIds }) as any

test('allow_all authorizes anyone, even a non-allowlisted user with no member', async () => {
  const thread = threadWithAccess({ ...closed, allow_all: true })
  const r = await hasPermission(null, userObj('rando'), thread)
  assert.equal(r.authorized, true)
})

test('a closed allowlist denies an unknown, non-creator user', async () => {
  const thread = threadWithAccess(closed)
  const r = await hasPermission(null, userObj('rando'), thread)
  assert.equal(r.authorized, false)
})

test('the thread creator can always access their own thread', async () => {
  const thread = threadWithAccess(closed, { ownerId: 'CREATOR' })
  const r = await hasPermission(null, userObj('CREATOR'), thread)
  assert.equal(r.authorized, true)
})

test('a user on the allowed_users list is authorized', async () => {
  const thread = threadWithAccess({ ...closed, allowed_users: ['U1'] })
  assert.equal((await hasPermission(null, userObj('U1'), thread)).authorized, true)
  assert.equal((await hasPermission(null, userObj('U2'), thread)).authorized, false)
})

test('a GuildMember holding an allowed role is authorized', async () => {
  const thread = threadWithAccess({ ...closed, allowed_roles: ['R1'] })
  assert.equal((await hasPermission(guildMember(['R1']), userObj('x'), thread)).authorized, true)
  assert.equal((await hasPermission(guildMember(['R9']), userObj('x'), thread)).authorized, false)
})

test('an APIInteractionGuildMember (roles: string[]) holding an allowed role is authorized', async () => {
  const thread = threadWithAccess({ ...closed, allowed_roles: ['R1'] })
  assert.equal((await hasPermission(apiMember(['R1']), userObj('x'), thread)).authorized, true)
  assert.equal((await hasPermission(apiMember([]), userObj('x'), thread)).authorized, false)
})

test('role allowlist is ignored when no member is supplied', async () => {
  const thread = threadWithAccess({ ...closed, allowed_roles: ['R1'] })
  assert.equal((await hasPermission(null, userObj('x'), thread)).authorized, false)
})

test('the silent flag is reported on both authorized and denied results', async () => {
  const open = threadWithAccess({ ...closed, allow_all: true, silent: true })
  const denyT = threadWithAccess({ ...closed, silent: true })
  assert.deepEqual(await hasPermission(null, userObj('x'), open), {
    authorized: true,
    silent: true,
  })
  assert.deepEqual(await hasPermission(null, userObj('x'), denyT), {
    authorized: false,
    silent: true,
  })
})

test('silent defaults to false when unset', async () => {
  const thread = threadWithAccess(closed)
  assert.equal((await hasPermission(null, userObj('x'), thread)).silent, false)
})
