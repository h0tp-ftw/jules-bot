import { EmbedBuilder, type APIEmbedField } from 'discord.js'

export type SystemEmbedType = 'info' | 'success' | 'warning' | 'error'

export const SYSTEM_EMBED_COLORS: Record<SystemEmbedType, number> = {
  info: 0x5865f2, // Discord Blurple
  success: 0x57f287, // Green
  warning: 0xfee75c, // Yellow / Amber
  error: 0xed4245, // Red
}

export const SYSTEM_EMBED_DEFAULT_TITLES: Record<SystemEmbedType, string> = {
  info: 'ℹ️ Notice',
  success: '✅ Success',
  warning: '⚠️ Notice',
  error: '❌ Error',
}

export interface SystemEmbedOptions {
  title?: string
  description?: string
  footer?: string
  fields?: APIEmbedField[]
}

/**
 * Creates a clean, standard Discord embed for system notices, alerts, and errors.
 */
export function createSystemEmbed(
  type: SystemEmbedType,
  options: SystemEmbedOptions = {},
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(SYSTEM_EMBED_COLORS[type])
    .setTitle(options.title || SYSTEM_EMBED_DEFAULT_TITLES[type])

  if (options.description) {
    // Discord embed descriptions have a 4096 character limit
    embed.setDescription(options.description.slice(0, 4000))
  }

  if (options.fields && options.fields.length > 0) {
    embed.addFields(options.fields)
  }

  if (options.footer) {
    embed.setFooter({ text: options.footer.slice(0, 2048) })
  }

  return embed
}
