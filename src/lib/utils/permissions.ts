import { GuildMember, User, APIInteractionGuildMember } from 'discord.js'
import { getEffectiveConfig } from '../../config.js'

export async function hasPermission(
  member: GuildMember | APIInteractionGuildMember | null,
  user: User,
  thread?: any,
): Promise<{ authorized: boolean; silent: boolean }> {
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
  const isSilent = ac.silent === true

  if (ac.allow_all) return { authorized: true, silent: isSilent }

  // Thread creator always has permission to access their own thread
  if (thread && user.id === thread.ownerId) return { authorized: true, silent: isSilent }

  // Check user ID allowlist
  if (ac.allowed_users.includes(user.id)) return { authorized: true, silent: isSilent }

  // Check role allowlist
  if (member && ac.allowed_roles.length > 0) {
    // member can be GuildMember or APIInteractionGuildMember (in API interactions)
    let hasRole = false
    if ('roles' in member) {
      if (Array.isArray(member.roles)) {
        // APIInteractionGuildMember has roles as string[]
        hasRole = member.roles.some((roleId) => ac.allowed_roles.includes(roleId))
      } else {
        // GuildMember has roles as collection
        hasRole = member.roles.cache.some((role) => ac.allowed_roles.includes(role.id))
      }
    }
    if (hasRole) return { authorized: true, silent: isSilent }
  }

  return { authorized: false, silent: isSilent }
}
