import { GuildMember, User, APIInteractionGuildMember } from 'discord.js'
import { getEffectiveConfig } from '../../config.js'

export function hasPermission(
  member: GuildMember | APIInteractionGuildMember | null,
  user: User,
  thread?: any
): boolean {
  const config = getEffectiveConfig(thread, member)
  const ac = config.access_control

  if (ac.allow_all) return true

  // Check user ID allowlist
  if (ac.allowed_users.includes(user.id)) return true

  // Check role allowlist
  if (member && ac.allowed_roles.length > 0) {
    // member can be GuildMember or APIInteractionGuildMember (in API interactions)
    if ('roles' in member) {
      if (Array.isArray(member.roles)) {
        // APIInteractionGuildMember has roles as string[]
        return member.roles.some((roleId) => ac.allowed_roles.includes(roleId))
      } else {
        // GuildMember has roles as collection
        return member.roles.cache.some((role) => ac.allowed_roles.includes(role.id))
      }
    }
  }

  return false
}
