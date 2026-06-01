import { GuildMember, User, APIInteractionGuildMember } from 'discord.js'
import { getEffectiveConfig } from '../../config.js'

export async function hasPermission(
  member: GuildMember | APIInteractionGuildMember | null,
  user: User,
  thread?: any
): Promise<boolean> {
  let creatorMember: any = null
  if (thread && thread.guild && thread.ownerId) {
    creatorMember = thread.guild.members.cache.get(thread.ownerId)
    if (!creatorMember) {
      try {
        creatorMember = await thread.guild.members.fetch(thread.ownerId)
      } catch (err) {
        // Ignore fetch errors
      }
    }
  }

  const config = getEffectiveConfig(thread, creatorMember)
  const ac = config.access_control

  if (ac.allow_all) return true

  // Thread creator always has permission to access their own thread
  if (thread && user.id === thread.ownerId) return true

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
