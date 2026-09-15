import { logger } from './logger.js'

// Minimal structural view of a Discord channel so this module stays
// unit-testable without importing discord.js.
export interface TypingChannelLike {
  id: string
  sendTyping: () => Promise<unknown>
}

type TypingLoop = {
  interval: NodeJS.Timeout
  safetyTimeout: NodeJS.Timeout
}

// Discord typing bubbles expire after ~10 seconds, so refresh a little faster.
const TYPING_REFRESH_MS = 8000
// Hard stop so a lost stop signal (crashed stream, dropped activity) can never
// leave a channel "typing" forever.
const TYPING_SAFETY_TIMEOUT_MS = 30 * 60 * 1000

// One loop per channel, shared by every caller (message dispatch, stream
// handler, interaction handlers). Sharing prevents the previous failure mode
// where a one-shot sendTyping() from the dispatch path expired before the
// stream handler's own timer took over, leaving gaps with no indicator.
const typingLoops = new Map<string, TypingLoop>()

function fireTyping(channel: TypingChannelLike) {
  try {
    void Promise.resolve(channel.sendTyping()).catch(() => {})
  } catch {
    // Typing is best-effort; never let it break the caller.
  }
}

export function startTypingLoop(channel: TypingChannelLike): void {
  if (typingLoops.has(channel.id)) return
  fireTyping(channel)
  const interval = setInterval(() => fireTyping(channel), TYPING_REFRESH_MS)
  const safetyTimeout = setTimeout(() => {
    logger.warn(
      `[TypingManager] Typing loop for channel ${channel.id} hit the 30-minute safety timeout.`,
    )
    stopTypingLoop(channel.id)
  }, TYPING_SAFETY_TIMEOUT_MS)
  typingLoops.set(channel.id, { interval, safetyTimeout })
}

export function stopTypingLoop(channelId: string): void {
  const loop = typingLoops.get(channelId)
  if (!loop) return
  clearInterval(loop.interval)
  clearTimeout(loop.safetyTimeout)
  typingLoops.delete(channelId)
}

export function isTypingLoopActive(channelId: string): boolean {
  return typingLoops.has(channelId)
}
