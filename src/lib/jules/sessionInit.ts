import { logger } from '../utils/logger.js'
import { Message, ThreadChannel } from 'discord.js'
import { JulesClient } from './JulesClient.js'
import type { StreamManager } from '../streams/StreamManager.js'
import { prisma, getEffectiveConfig } from '../../config.js'
import { replenishPool } from './PreWarmedManager.js'
import { formatAttachmentMetadata } from '../utils/attachments.js'
import { buildReplyAwarePrompt } from '../utils/reply.js'
import { enqueueConversationMessage, markConversationTurnDispatched } from './ConversationQueue.js'
import { scheduleJulesRequest } from './JulesRequestCoordinator.js'
import { updateReaction } from './reactions.js'
import { getActivityDate } from './deliveryCursor.js'
import { scheduleNudgeForConversationTurn } from './nudges.js'
import { runJulesStream } from './runJulesStream.js'
import {
  resolvePoolContext,
  consumePreWarmedSession,
  dispatchPreWarmedUserTurn,
} from './session/preWarmedConsumer.js'

export { initializeChatSession } from './session/chatSession.js'

export async function initializeJulesSession(
  thread: ThreadChannel,
  repoName: string,
  branchName: string,
  streamManager: StreamManager,
) {
  const starterMessage = await thread.fetchStarterMessage()
  if (!starterMessage || (!starterMessage.content && starterMessage.attachments.size === 0)) {
    await thread.send(getEffectiveConfig(thread).messages.session.starter_message_unavailable)
    return
  }

  let resolveInitialized: () => void = () => {}
  let rejectInitialized: (error: unknown) => void = () => {}
  const initialized = new Promise<void>((resolve, reject) => {
    resolveInitialized = resolve
    rejectInitialized = reject
  })

  const completion = enqueueConversationMessage(
    thread.id,
    starterMessage,
    async (turn) => {
      try {
        await initializeJulesSessionCore(
          thread,
          repoName,
          branchName,
          streamManager,
          starterMessage,
          turn.id,
        )
        resolveInitialized()
        return true
      } catch (err) {
        rejectInitialized(err)
        throw err
      }
    },
    () => updateReaction(starterMessage, 'queued'),
  )
  void completion.catch((err) => {
    logger.error(`[initializeJulesSession] Queued starter turn failed for ${thread.id}:`, err)
  })

  await initialized
}

async function initializeJulesSessionCore(
  thread: ThreadChannel,
  repoName: string,
  branchName: string,
  streamManager: StreamManager,
  starterMessage: Message,
  queueTurnId: string,
) {
  const authorNickname = starterMessage.member?.displayName || starterMessage.author.username
  const authorUsername = starterMessage.author.username
  const authorId = starterMessage.author.id
  const messageTime = starterMessage.createdAt.toISOString()
  const threadTitle = thread.name

  const threadConfig = getEffectiveConfig(thread, starterMessage.member)

  let starterContent = starterMessage.content || ''
  if (starterMessage.attachments.size > 0) {
    const attachmentList = Array.from(starterMessage.attachments.values()).map((att) => ({
      name: att.name,
      url: att.url,
      contentType: att.contentType || undefined,
      size: att.size || undefined,
    }))

    starterContent += formatAttachmentMetadata(attachmentList, threadConfig.messages.attachments)
  }

  const promptWithMetadata = await buildReplyAwarePrompt(
    starterMessage,
    threadConfig.reply_context_mode,
    threadConfig.messages.prompts.metadata_header_with_title,
    {
      nickname: authorNickname,
      username: authorUsername,
      id: authorId,
      message_id: starterMessage.id,
      time: messageTime,
      title: threadTitle,
      content: starterContent,
    },
    threadConfig.messages.prompts,
  )

  const { contextKey, usePool } = resolvePoolContext(
    thread,
    starterMessage.member,
    branchName,
    threadConfig,
  )

  let consumed = usePool
    ? await consumePreWarmedSession(repoName, contextKey, thread, threadConfig)
    : null

  let session = consumed?.session || null
  const usedPreWarmed = Boolean(session)
  const initialSkipIds = consumed?.initialSkipIds
  const initialCursorActivity = consumed?.initialCursorActivity

  if (!session) {
    markConversationTurnDispatched(thread.id, queueTurnId)
    session = await scheduleJulesRequest(() =>
      JulesClient.createSession({
        prompt: promptWithMetadata,
        repo: repoName,
        branch: branchName,
        title: thread.name,
        thread: thread,
        member: starterMessage.member,
      }),
    )
  }

  await prisma.debugSession.create({
    data: {
      threadId: thread.id,
      guildId: thread.guildId,
      julesSessionId: session.id,
      repoName: repoName,
      deliveryCursorInitialized: true,
      lastDeliveredActivityId: initialCursorActivity?.id || null,
      lastDeliveredActivityAt: getActivityDate(initialCursorActivity),
    },
  })

  // Start processing events in the background
  if (!usedPreWarmed) {
    runJulesStream(session.id, thread, streamManager, initialSkipIds)
  } else if (consumed) {
    await dispatchPreWarmedUserTurn(
      session,
      thread,
      promptWithMetadata,
      consumed.welcomePlanRejected,
      consumed.welcomeFeedback,
      threadConfig,
      queueTurnId,
    )
    runJulesStream(session.id, thread, streamManager, initialSkipIds)
  }

  if (usePool) {
    replenishPool(repoName, contextKey).catch(() => {})
  }

  scheduleNudgeForConversationTurn(thread, queueTurnId, session, starterMessage.member, repoName)
}
