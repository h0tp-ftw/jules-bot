import { GuildMember, User, APIInteractionGuildMember } from 'discord.js'
import { ALLOW_ALL, ALLOWED_USERS, ALLOWED_ROLES } from '../../config.js'

export function hasPermission(
  member: GuildMember | APIInteractionGuildMember | null,
  user: User
): boolean {
  if (ALLOW_ALL) return true

  // Check user ID allowlist
  if (ALLOWED_USERS.includes(user.id)) return true

  // Check role allowlist
  if (member && ALLOWED_ROLES.length > 0) {
    // member can be GuildMember or APIInteractionGuildMember (in API interactions)
    if ('roles' in member) {
      if (Array.isArray(member.roles)) {
        // APIInteractionGuildMember has roles as string[]
        return member.roles.some((roleId) => ALLOWED_ROLES.includes(roleId))
      } else {
        // GuildMember has roles as collection
        return member.roles.cache.some((role) => ALLOWED_ROLES.includes(role.id))
      }
    }
  }

  return false
}
