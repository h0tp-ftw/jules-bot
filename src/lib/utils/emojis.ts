import { Client } from 'discord.js'

/**
 * Dynamically resolves custom Discord emojis in a text string.
 * It matches both full emoji syntax (<a?:name:id>) and short emoji syntax (:name:)
 * and attempts to find matching emojis in the client's cache to replace their IDs with correct local ones.
 */
export function resolveMessageEmojis(
  client?: Client | null,
  text?: string,
  customMapping?: Record<string, string>,
): string {
  if (!text) return ''

  // 1. Resolve full custom emoji formats: <a?:name:id>
  let resolved = text.replace(/<a?:([a-zA-Z0-9_]+):([0-9]+)>/g, (match, name, id) => {
    // Check config/custom dictionary first if supplied
    if (customMapping) {
      const mapped = customMapping[name] || customMapping[name.toLowerCase()]
      if (mapped) return mapped
    }
    const cachedEmoji = typeof client?.emojis?.cache?.find === 'function'
      ? client.emojis.cache.find((e) => e.name?.toLowerCase() === name.toLowerCase())
      : undefined
    if (cachedEmoji) {
      const animated = cachedEmoji.animated ? 'a' : ''
      return `<${animated}:${cachedEmoji.name}:${cachedEmoji.id}>`
    }
    return match // Keep original if not found locally
  })

  // 2. Resolve short formats: :name:
  // Checked against customMapping first, then client.emojis.cache
  resolved = resolved.replace(/:([a-zA-Z0-9_]+):(?!\d)/g, (match, name) => {
    if (customMapping) {
      const mapped = customMapping[name] || customMapping[name.toLowerCase()]
      if (mapped) return mapped
    }
    const cachedEmoji = typeof client?.emojis?.cache?.find === 'function'
      ? client.emojis.cache.find((e) => e.name?.toLowerCase() === name.toLowerCase())
      : undefined
    if (cachedEmoji) {
      const animated = cachedEmoji.animated ? 'a' : ''
      return `<${animated}:${cachedEmoji.name}:${cachedEmoji.id}>`
    }
    return match // Keep original (could be standard unicode emoji like :heart:)
  })

  return resolved
}
