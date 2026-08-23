import { logger } from '../lib/utils/logger.js'
import type { Client } from 'discord.js'
import { prisma, getEffectiveConfig } from '../config.js'
import { t } from '../strings.js'
import { splitMessage } from '../lib/utils/messageSplitter.js'
import {
  getActiveConversationQueueSnapshots,
  type ActiveConversationQueueSnapshot,
} from '../lib/jules/ConversationQueue.js'
import { stopHealthServer } from '../lib/health.js'
import type { StreamManager } from '../lib/streams/StreamManager.js'

// Gracefully tear down on shutdown signals (pm2 reload/stop, Ctrl+C) so pending
// status-message edits are dropped cleanly and the gateway/DB connections close
// instead of being hard-killed mid-write.
const SHUTDOWN_NOTICE_TIMEOUT_MS = 2500

function getShutdownPendingText(snapshot: ActiveConversationQueueSnapshot): string {
  const cfg = getEffectiveConfig(snapshot.turn.message.channel, snapshot.turn.message.member)
  if (snapshot.pendingCount === 0) return ''
  if (snapshot.pendingCount === 1) return cfg.messages.session.shutdown_queue_pending_one
  return t(cfg.messages.session.shutdown_queue_pending_many, { count: snapshot.pendingCount })
}

async function sendShutdownQueueNotice(snapshot: ActiveConversationQueueSnapshot): Promise<void> {
  const { message } = snapshot.turn
  const cfg = getEffectiveConfig(message.channel, message.member)
  const content = t(cfg.messages.session.shutdown_queue_active, {
    pending: getShutdownPendingText(snapshot),
  })
  const chunks = splitMessage(content, 2000)
  if (chunks.length === 0) return

  const sendInChannel = async (chunk: string) => {
    if (!('send' in message.channel) || typeof message.channel.send !== 'function') {
      throw new Error(`Channel ${message.channel.id} is not sendable`)
    }
    await message.channel.send(chunk)
  }

  try {
    await message.reply({ content: chunks[0], allowedMentions: { repliedUser: false } })
  } catch (err) {
    logger.warn(
      `[Shutdown] Could not reply to active queue message ${message.id}; sending in channel instead:`,
      err,
    )
    await sendInChannel(chunks[0])
  }

  for (const chunk of chunks.slice(1)) {
    await sendInChannel(chunk)
  }
}

async function notifyActiveConversationQueues(client: Client): Promise<void> {
  if (!client.isReady()) return
  const snapshots = getActiveConversationQueueSnapshots()
  if (snapshots.length === 0) return

  logger.info(`[Shutdown] Notifying ${snapshots.length} active conversation queue(s)...`)
  let timeout: NodeJS.Timeout | undefined
  let timedOut = false
  await Promise.race([
    Promise.allSettled(snapshots.map(sendShutdownQueueNotice)),
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true
        resolve()
      }, SHUTDOWN_NOTICE_TIMEOUT_MS)
    }),
  ])
  if (timeout) clearTimeout(timeout)
  if (timedOut) {
    logger.warn('[Shutdown] Queue notices exceeded the shutdown time budget; continuing cleanup.')
  }
}

let shuttingDown = false
async function shutdown(
  client: Client,
  streamManager: StreamManager,
  signal: string,
  exitCode = 0,
) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`[Shutdown] ${signal} received — cleaning up...`)
  try {
    await notifyActiveConversationQueues(client)
  } catch (err) {
    logger.error('[Shutdown] active queue notification failed:', err)
  }
  try {
    stopHealthServer()
  } catch (err) {
    logger.error('[Shutdown] health server stop failed:', err)
  }
  try {
    streamManager.dispose()
  } catch (err) {
    logger.error('[Shutdown] streamManager dispose failed:', err)
  }
  try {
    await client.destroy()
  } catch (err) {
    logger.error('[Shutdown] client destroy failed:', err)
  }
  try {
    await prisma.$disconnect()
  } catch (err) {
    logger.error('[Shutdown] prisma disconnect failed:', err)
  }
  process.exit(exitCode)
}

/**
 * Registers every process-level lifecycle handler: graceful shutdown on
 * SIGINT/SIGTERM, uncaught-exception teardown, and network-blip rejection
 * logging. Call once during boot, before the gateway login.
 */
export function setupProcessLifecycle(deps: { client: Client; streamManager: StreamManager }) {
  const { client, streamManager } = deps

  process.on('SIGINT', () => {
    shutdown(client, streamManager, 'SIGINT')
  })
  process.on('SIGTERM', () => {
    shutdown(client, streamManager, 'SIGTERM')
  })

  // Network blips surface as unhandled rejections from awaited Discord/Jules calls;
  // log and keep running so a transient dropout doesn't take the bot down.
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason)
  })

  // An uncaught exception leaves the process in an undefined state — continuing
  // risks operating on corrupted in-memory state (active streams, buffers). Shut
  // down cleanly and let the process manager (pm2) restart us fresh.
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error)
    shutdown(client, streamManager, 'uncaughtException', 1)
  })
}
