import { Client } from 'discord.js'

/**
 * Dynamically resolves custom Discord emojis in a text string.
 * It matches both full emoji syntax (<a?:name:id>) and short emoji syntax (:name:)
 * and attempts to find matching emojis in the client's cache to replace their IDs with correct local ones.
 */
export function resolveMessageEmojis(client: Client, text: string): string {
  if (!text) return text

  // 1. Resolve full custom emoji formats: <a?:name:id>
  let resolved = text.replace(/<a?:([a-zA-Z0-9_]+):([0-9]+)>/g, (match, name, id) => {
    const cachedEmoji = client.emojis.cache.find(
      (e) => e.name?.toLowerCase() === name.toLowerCase()
    )
    if (cachedEmoji) {
      const animated = cachedEmoji.animated ? 'a' : ''
      return `<${animated}:${cachedEmoji.name}:${cachedEmoji.id}>`
    }
    return match // Keep original if not found locally
  })

  // 2. Resolve short formats: :name: (only if name matches a custom emoji in the client's cache).
  // The `(?!\d)` lookahead prevents re-matching the ":name:" inside an already-resolved
  // <:name:id> tag (where the closing colon is followed by the numeric id).
  resolved = resolved.replace(/:([a-zA-Z0-9_]+):(?!\d)/g, (match, name) => {
    const cachedEmoji = client.emojis.cache.find(
      (e) => e.name?.toLowerCase() === name.toLowerCase()
    )
    if (cachedEmoji) {
      const animated = cachedEmoji.animated ? 'a' : ''
      return `<${animated}:${cachedEmoji.name}:${cachedEmoji.id}>`
    }
    return match // Keep original (could be standard unicode emoji like :heart:)
  })

  return resolved
}
