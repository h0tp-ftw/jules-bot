import { logger } from '../../utils/logger.js'
import type { JulesDiscordChannel } from '../channelTypes.js'

export type TypingController = {
  start: () => void
  stop: () => void
  handleActivity: (typeStr: string, typingMode: string) => void
}

export function createTypingController(thread: JulesDiscordChannel): TypingController {
  let typingInterval: NodeJS.Timeout | null = null
  let typingTimeout: NodeJS.Timeout | null = null

  const start = () => {
    if (typingInterval) return
    thread.sendTyping().catch(() => {})
    typingInterval = setInterval(() => {
      thread.sendTyping().catch(() => {})
    }, 8000)

    typingTimeout = setTimeout(
      () => {
        logger.warn(
          `[runJulesStream] Typing indicator timed out after 30 minutes for thread ${thread.id}`,
        )
        stop()
      },
      30 * 60 * 1000,
    )
  }

  const stop = () => {
    if (typingInterval) {
      clearInterval(typingInterval)
      typingInterval = null
    }
    if (typingTimeout) {
      clearTimeout(typingTimeout)
      typingTimeout = null
    }
  }

  const handleActivity = (typeStr: string, typingMode: string) => {
    if (typingMode === 'strict_state') {
      if (typeStr === 'userMessaged' || typeStr === 'progressUpdated') {
        start()
      } else if (typeStr === 'sessionCompleted' || typeStr === 'sessionFailed') {
        stop()
      }
    } else {
      if (typeStr === 'userMessaged') {
        start()
      } else if (
        typeStr === 'agentMessaged' ||
        typeStr === 'planGenerated' ||
        typeStr === 'sessionCompleted' ||
        typeStr === 'sessionFailed'
      ) {
        stop()
      }
    }
  }

  return { start, stop, handleActivity }
}
