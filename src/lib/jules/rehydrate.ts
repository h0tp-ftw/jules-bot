import { logger } from '../utils/logger.js'
import { ChannelType } from 'discord.js'
import { prisma, YAML_GUILDS, JULES_POLLING } from '../../config.js'
import { JulesClient } from './JulesClient.js'
import type { StreamManager } from '../streams/StreamManager.js'
import { isIdleSessionState } from '../utils/sessionState.js'
import { scheduleJulesRequest } from './JulesRequestCoordinator.js'
import { getFreshSessionInfo } from './sessionInfo.js'
import { runJulesStream } from './runJulesStream.js'
import type { JulesDiscordChannel } from './channelTypes.js'

export async function rehydrateActiveStreams(client: any, streamManager: StreamManager) {
  logger.debug('[rehydrateActiveStreams] Starting rehydration of active streams...')
  try {
    const oneDayAgo = new Date()
    oneDayAgo.setDate(oneDayAgo.getDate() - 1)

    const sessions = await prisma.debugSession.findMany({
      where: {
        updatedAt: { gte: oneDayAgo },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    })

    logger.debug(
      `[rehydrateActiveStreams] Found ${sessions.length} sessions in DB updated in the last 24 hours.`,
    )

    const guildConfigs = await prisma.guildConfig.findMany({
      select: { guildId: true, chatChannelId: true },
    })
    const guildConfigById = new Map(guildConfigs.map((config) => [config.guildId, config]))
    const idleCutoffMs = Date.now() - JULES_POLLING.idle_timeout_ms

    for (const session of sessions) {
      try {
        const channel = await client.channels.fetch(session.threadId)
        if (!channel || (!channel.isThread() && channel.type !== ChannelType.GuildText)) continue
        const sessionChannel = channel as JulesDiscordChannel
        if (!sessionChannel.isThread()) {
          const configuredChatChannelId =
            YAML_GUILDS[session.guildId]?.chat_channel_id ||
            guildConfigById.get(session.guildId)?.chatChannelId
          if (configuredChatChannelId !== sessionChannel.id) {
            logger.debug(
              `[rehydrateActiveStreams] Text channel ${sessionChannel.id} is no longer the configured chatbot channel for guild ${session.guildId}. Skipping.`,
            )
            continue
          }
        }
        if (sessionChannel.isThread() && (sessionChannel.archived || sessionChannel.locked)) {
          logger.debug(
            `[rehydrateActiveStreams] Thread ${sessionChannel.id} is archived or locked. Skipping.`,
          )
          continue
        }

        // Do not grant every old completed session a fresh one-hour polling window
        // just because the bot restarted. For records older than the idle grace
        // period, spend one paced info request to keep only genuinely active work.
        if (session.updatedAt.getTime() < idleCutoffMs) {
          const remoteSession = JulesClient.getSession(session.julesSessionId)
          const info = await scheduleJulesRequest(() => getFreshSessionInfo(remoteSession))
          if (!info || info.state === 'failed' || isIdleSessionState(info.state)) {
            logger.debug(
              `[rehydrateActiveStreams] Session ${session.julesSessionId} is stale and ${info?.state || 'unavailable'}; leaving it dormant until the next Discord action.`,
            )
            continue
          }
        }

        const chatbotMode = !sessionChannel.isThread()
        logger.debug(
          `[rehydrateActiveStreams] Rehydrating stream for ${chatbotMode ? 'chatbot channel' : 'thread'} ${sessionChannel.id}, sessionId: ${session.julesSessionId}`,
        )
        // runJulesStream checks if it's already active. Its initialization and all
        // Jules network calls are paced by the shared scheduler, so startup no
        // longer needs a separate fixed inter-session sleep.
        void runJulesStream(
          session.julesSessionId,
          sessionChannel,
          streamManager,
          undefined,
          undefined,
          { chatbotMode },
        ).catch((err) => {
          logger.error(
            `[rehydrateActiveStreams] Stream failed for session ${session.julesSessionId} in ${sessionChannel.id}:`,
            err,
          )
        })
      } catch (err) {
        logger.error(
          `[rehydrateActiveStreams] Failed to rehydrate session ${session.julesSessionId} for thread ${session.threadId}:`,
          err,
        )
      }
    }
  } catch (err) {
    logger.error('[rehydrateActiveStreams] Failed to query active sessions from database:', err)
  }
}
