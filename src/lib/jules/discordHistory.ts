import { logger } from '../utils/logger.js'
import type { Message } from 'discord.js'
import type { JulesDiscordChannel } from './channelTypes.js'

// Fetch the most recent non-bot message in a channel/thread. Used to pin
// replies and reaction targets to the human who is actually waiting.
export async function getLastHumanMessage(thread: JulesDiscordChannel): Promise<Message | null> {
  try {
    const messages = await thread.messages.fetch({ limit: 20 })
    const sorted = Array.from(messages.values()).sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    )
    const lastHuman = sorted.find((m) => !m.author.bot)
    return lastHuman || null
  } catch (err) {
    logger.error('Failed to fetch last human message for reply:', err)
    return null
  }
}

// Newest message timestamp this bot itself posted in the thread. Used as the
// legacy baseline when establishing the delivery cursor for existing sessions.
export async function getLatestBotMessageTimestamp(
  thread: JulesDiscordChannel,
): Promise<number | null> {
  const botId = thread.client.user?.id
  if (!botId) return null

  try {
    const messages = await thread.messages.fetch({ limit: 100 })
    let latest: number | null = null
    for (const message of messages.values()) {
      if (message.author.id !== botId) continue
      if (latest === null || message.createdTimestamp > latest) {
        latest = message.createdTimestamp
      }
    }
    return latest
  } catch (err) {
    logger.warn(
      `[runJulesStream] Could not inspect recent Discord messages for legacy delivery recovery in thread ${thread.id}:`,
      err,
    )
    return null
  }
}
