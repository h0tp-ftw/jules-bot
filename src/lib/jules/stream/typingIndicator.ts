import { startTypingLoop, stopTypingLoop } from '../../utils/typingManager.js'
import type { JulesDiscordChannel } from '../channelTypes.js'

export type TypingController = {
  start: () => void
  stop: () => void
  handleActivity: (typeStr: string, typingMode: string) => void
}

export function createTypingController(thread: JulesDiscordChannel): TypingController {
  const start = () => startTypingLoop(thread)
  const stop = () => stopTypingLoop(thread.id)

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
