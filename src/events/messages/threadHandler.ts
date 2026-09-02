import { Message, ThreadChannel } from 'discord.js'
import { prisma } from '../../config.js'
import type { StreamManager } from '../../lib/streams/StreamManager.js'
import type { ConversationTurn } from '../../lib/jules/ConversationQueue.js'
import { sendToExistingSession, shouldIgnoreMessage } from './sessionSender.js'

export type SessionRoutingRecord = {
  julesSessionId: string
}

export type ThreadRoutingContext = {
  dbDefaultRepo?: string
  sessionRecord: SessionRoutingRecord
}

export async function resolveThreadRoutingContext(
  message: Message,
  thread: ThreadChannel,
): Promise<ThreadRoutingContext | null> {
  if (!message.guildId) return null

  const sessionRecord = await prisma.debugSession.findUnique({
    where: { threadId: thread.id },
  })
  if (!sessionRecord) return null

  const dbConfig = await prisma.guildConfig.findUnique({
    where: { guildId: message.guildId },
  })
  const dbDefaultRepo = dbConfig?.defaultRepo || undefined

  if (shouldIgnoreMessage(message, thread, dbDefaultRepo)) return null
  return { dbDefaultRepo, sessionRecord }
}

export async function processThreadMessage(
  message: Message,
  thread: ThreadChannel,
  streamManager: StreamManager,
  turn: ConversationTurn,
  routing: ThreadRoutingContext,
): Promise<boolean> {
  return await sendToExistingSession(
    message,
    thread,
    routing.sessionRecord,
    streamManager,
    false,
    turn.id,
    routing.dbDefaultRepo,
  )
}
