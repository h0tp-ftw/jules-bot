import { logger } from '../utils/logger.js'
import type { Message } from 'discord.js'
import { getEffectiveConfig } from '../../config.js'
import { resolveMessageEmojis } from '../utils/emojis.js'

function parseEmojiForReaction(client: any, emojiStr: string): string {
  const trimmed = emojiStr.trim()
  // Match <:name:id> or <a:name:id>
  const match = trimmed.match(/^<a?:([a-zA-Z0-9_]+):([0-9]+)>$/)
  if (match) {
    return `${match[1]}:${match[2]}`
  }

  // Match raw name:id
  const rawMatch = trimmed.match(/^([a-zA-Z0-9_]+):([0-9]+)$/)
  if (rawMatch) {
    return trimmed
  }

  // Match raw ID
  if (/^[0-9]+$/.test(trimmed)) {
    const cachedEmoji = client.emojis.cache.get(trimmed)
    if (cachedEmoji) {
      return `${cachedEmoji.name}:${cachedEmoji.id}`
    }
    return trimmed
  }

  return trimmed
}

// Tracks the last reaction stage applied to a given message id so updateReaction
// can skip redundant remove/re-add API calls when the stage hasn't changed.
const messageReactionStage = new Map<string, string>()
// Bound for messageReactionStage so a long-lived process doesn't leak one entry
// per message that ever received a reaction. Map preserves insertion order, so we
// evict the oldest key once over the cap.
const MAX_REACTION_STAGE_ENTRIES = 5000

// Remove every reaction this bot previously added to `message`. Shared by the
// state-driven updateReaction and the Jules-driven applyJulesReactions so a new
// reaction set always cleanly replaces the old one.
async function clearBotReactions(message: Message) {
  const botId = message.client.user?.id
  if (!botId) return
  for (const reaction of message.reactions.cache.values()) {
    try {
      if (reaction.me) {
        await reaction.users.remove(botId)
      }
    } catch (err) {
      // Ignore removal errors
    }
  }
}

// Record the reaction stage currently shown on a message (for dedup), evicting
// the oldest entry once over the cap so a long-lived process doesn't leak.
function rememberStage(messageId: string, stage: string) {
  messageReactionStage.set(messageId, stage)
  if (messageReactionStage.size > MAX_REACTION_STAGE_ENTRIES) {
    const oldest = messageReactionStage.keys().next().value
    if (oldest !== undefined) messageReactionStage.delete(oldest)
  }
}

export async function updateReaction(message: Message | null, newStage: string) {
  if (!message) return
  // Skip redundant work if this message is already showing the target stage.
  if (messageReactionStage.get(message.id) === newStage) return
  try {
    // Remove any existing bot reactions to clean up previous stages
    await clearBotReactions(message)

    // Add new reaction emoji
    const threadConfig = getEffectiveConfig(message.channel, message.member)
    const reactions = threadConfig.reactions || {}
    const emojiStr = reactions[newStage]
    if (emojiStr) {
      const emoji = parseEmojiForReaction(message.client, emojiStr)
      await message.react(emoji)
    }
    rememberStage(message.id, newStage)
  } catch (err) {
    logger.error(`Failed to update reaction to stage ${newStage}:`, err)
  }
}

// Apply Jules-authored reactions (parsed from [[react:…]] markers in an agent
// message) to `message`, replacing any state-driven reaction. Records a sentinel
// stage so a later lifecycle transition (completed/failed/in_progress) still
// overrides it. Each emoji is resolved through the same shortcode/custom-emoji
// pipeline as agent message text before being handed to message.react().
export async function applyJulesReactions(
  message: Message | null,
  emojis: string[],
): Promise<boolean> {
  if (!message || emojis.length === 0) return false
  try {
    await clearBotReactions(message)
    let applied = false
    for (const raw of emojis) {
      try {
        const resolved = resolveMessageEmojis(message.client, raw)
        const emoji = parseEmojiForReaction(message.client, resolved)
        await message.react(emoji)
        applied = true
      } catch (err) {
        logger.warn(`[applyJulesReactions] Could not react with "${raw}":`, err)
      }
    }
    if (applied) rememberStage(message.id, `jules:${emojis.join(' ')}`)
    return applied
  } catch (err) {
    logger.error('[applyJulesReactions] Failed to apply Jules reactions:', err)
    return false
  }
}
