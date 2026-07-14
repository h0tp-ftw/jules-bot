import { logger } from './lib/utils/logger.js'
import {
  Client,
  GatewayIntentBits,
  Collection,
  REST,
  Routes,
  Events,
  ActivityType,
  PresenceStatusData,
} from 'discord.js'
import {
  DISCORD_TOKEN,
  JULES_API_KEY,
  prisma,
  yamlConfig,
  MESSAGES,
  YAML_GUILDS,
} from './config.js'
import { t } from './strings.js'
import { formatErrorForDiscord } from './lib/utils/errors.js'
import linkRepoCmd from './commands/link-repo.js'
import setupForumCmd from './commands/setup-forum.js'
import approveCmd from './commands/approve.js'
import threadCreateEvt from './events/threadCreate.js'
import messageCreateEvt from './events/messageCreate.js'
import interactionCreateEvt from './events/interactionCreate.js'
import { StreamManager } from './lib/streams/StreamManager.js'
import { initPreWarmedPools } from './lib/jules/PreWarmedManager.js'
import { rehydrateActiveStreams } from './lib/jules/orchestrator.js'
import { startHealthServer, stopHealthServer } from './lib/health.js'

if (!DISCORD_TOKEN || DISCORD_TOKEN === 'YOUR_DISCORD_TOKEN') {
  logger.error('Error: DISCORD_TOKEN is not configured in .env file.')
  process.exit(1)
}

if (!JULES_API_KEY || JULES_API_KEY === 'YOUR_JULES_API_KEY') {
  logger.error('Error: JULES_API_KEY is not configured in .env file.')
  process.exit(1)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

const streamManager = new StreamManager(client)

// Bind commands collection
const commands = new Collection<string, any>()
commands.set(linkRepoCmd.data.name, linkRepoCmd)
commands.set(setupForumCmd.data.name, setupForumCmd)
commands.set(approveCmd.data.name, approveCmd)

import { hasPermission } from './lib/utils/permissions.js'

// Register events
client.on(Events.ThreadCreate, (thread) => {
  threadCreateEvt.execute(thread, streamManager)
})

client.on(Events.MessageCreate, (message) => {
  messageCreateEvt.execute(message, streamManager)
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    // Check permission. The reply is ephemeral, so only the unauthorized user
    // sees it (the `silent` flag is only meaningful for non-ephemeral surfaces).
    const { authorized } = await hasPermission(
      interaction.member,
      interaction.user,
      interaction.channel,
    )
    if (!authorized) {
      await interaction.reply({ content: MESSAGES.errors.no_permission_commands, ephemeral: true })
      return
    }

    const command = commands.get(interaction.commandName)
    if (!command) return

    try {
      await command.execute(interaction, streamManager)
    } catch (err: any) {
      logger.error(err)
      await interaction.reply({
        content: t(MESSAGES.errors.command_execution_error, { error: formatErrorForDiscord(err) }),
        ephemeral: true,
      })
    }
  } else {
    // Pass other interactions (buttons) to interactionCreate event
    await interactionCreateEvt.execute(interaction, streamManager)
  }
})

client.once(Events.ClientReady, async () => {
  logger.info(`🐙 Bot logged in as ${client.user?.tag}`)

  // Automatically register slash commands globally
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    const commandData = Array.from(commands.values()).map((cmd) => cmd.data.toJSON())

    // Global commands can take up to ~1 hour to propagate. Set DEV_GUILD_ID to
    // register them to a single guild instead — these appear instantly, which
    // makes first-run setup (e.g. /setup-forum) far less confusing.
    const devGuildId = process.env.DEV_GUILD_ID
    if (devGuildId) {
      logger.debug(`Registering guild (/) commands to dev guild ${devGuildId}...`)
      await rest.put(Routes.applicationGuildCommands(client.user!.id, devGuildId), {
        body: commandData,
      })
      logger.info(`Registered ${commandData.length} guild (/) commands to ${devGuildId} (instant).`)
    } else {
      logger.debug('Refreshing global application (/) commands...')
      await rest.put(Routes.applicationCommands(client.user!.id), {
        body: commandData,
      })
      logger.debug('Successfully reloaded global application (/) commands.')
    }
  } catch (error) {
    logger.error('Failed to register application commands:', error)
  }

  // Surface per-guild setup state so an operator can see what's left after
  // inviting the bot — a forum thread does nothing until both a forum channel
  // (/setup-forum) and a repo (/link-repo) are configured for that guild.
  try {
    const configs = await prisma.guildConfig.findMany()
    const byId = new Map(configs.map((c) => [c.guildId, c]))
    for (const guild of client.guilds.cache.values()) {
      const yamlGuild = YAML_GUILDS[guild.id] || {}
      const cfg = byId.get(guild.id)
      const repo = yamlGuild.default_repo || cfg?.defaultRepo
      const forum = yamlGuild.forum_channel_id || cfg?.forumChannelId
      const missing: string[] = []
      if (!forum) missing.push('forum channel (/setup-forum)')
      if (!repo) missing.push('repo (/link-repo)')
      if (missing.length) {
        logger.warn(`[Setup] "${guild.name}" not ready — still needs: ${missing.join(' + ')}`)
      } else {
        logger.info(`[Setup] "${guild.name}" ready — repo ${repo}, forum channel ${forum}`)
      }
    }
  } catch (err) {
    logger.error('[Setup] Failed to compute guild setup status:', err)
  }

  // Initialize pre-warmed pools
  initPreWarmedPools().catch((err) => {
    logger.error('Failed to initialize pre-warmed pools:', err)
  })

  // Rehydrate active streams
  rehydrateActiveStreams(client, streamManager).catch((err) => {
    logger.error('Failed to rehydrate active streams:', err)
  })

  // Set configurable presence
  const presence = yamlConfig.presence || {}
  if (presence.status || presence.activity) {
    let type = ActivityType.Playing
    if (presence.activity_type) {
      const activityType = presence.activity_type.toLowerCase()
      if (activityType === 'watching') type = ActivityType.Watching
      else if (activityType === 'listening') type = ActivityType.Listening
      else if (activityType === 'competing') type = ActivityType.Competing
      else if (activityType === 'streaming') type = ActivityType.Streaming
      else if (activityType === 'custom') type = ActivityType.Custom
    }

    client.user?.setPresence({
      status: (presence.status || 'online') as PresenceStatusData,
      activities: presence.activity
        ? [
            {
              name:
                type === ActivityType.Custom ? MESSAGES.misc.custom_status_name : presence.activity,
              state: type === ActivityType.Custom ? presence.activity : undefined,
              type: type,
              url: presence.url,
            },
          ]
        : [],
    })
  }
})

// Connect to SQLite and Login bot
async function start() {
  try {
    // Verify DB connection
    await prisma.$connect()
    logger.info('Connected to Database.')

    // SQLite durability hardening — matters most on SD-card / power-loss-prone
    // hosts (e.g. a Raspberry Pi). WAL survives an abrupt power cut far better
    // than the default rollback journal; synchronous=NORMAL stays durable under
    // WAL while avoiding an fsync per write; busy_timeout prevents spurious
    // SQLITE_BUSY errors when a write overlaps an in-flight read.
    try {
      await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
      await prisma.$executeRawUnsafe('PRAGMA synchronous=NORMAL;')
      await prisma.$executeRawUnsafe('PRAGMA busy_timeout=5000;')
      logger.debug(
        '[Database] SQLite pragmas applied (WAL, synchronous=NORMAL, busy_timeout=5000ms).',
      )
    } catch (err) {
      logger.error('[Database] Failed to apply SQLite pragmas:', err)
    }

    // Optional liveness endpoint — start before login so it can report
    // gateway:"connecting" while the bot comes up.
    const healthPort = Number(process.env.HEALTHCHECK_PORT)
    if (Number.isInteger(healthPort) && healthPort > 0) {
      startHealthServer(client, healthPort)
    }

    await loginWithRetry()
  } catch (err) {
    logger.error('Error starting bot:', err)
    process.exit(1)
  }
}

// Gracefully tear down on shutdown signals (pm2 reload/stop, Ctrl+C) so pending
// status-message edits are dropped cleanly and the gateway/DB connections close
// instead of being hard-killed mid-write.
let shuttingDown = false
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`[Shutdown] ${signal} received — cleaning up...`)
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

process.on('SIGINT', () => {
  shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  shutdown('SIGTERM')
})

// Network blips surface as unhandled rejections from awaited Discord/Jules calls;
// log and keep running so a transient dropout doesn't take the bot down.
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

// ---------------------------------------------------------------------------
// Network-resilient login
// ---------------------------------------------------------------------------

/** Error codes that indicate a transient network condition worth retrying. */
const NETWORK_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ENETUNREACH',
])

function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as any).code as string | undefined
  if (code && NETWORK_ERROR_CODES.has(code)) return true
  const msg: string = (err as any).message ?? ''
  return /connect timeout|econnrefused|enotfound|etimedout|econnreset/i.test(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getSessionWaitTime(msg: string): number {
  const match = msg.match(/resets at ([\d\-:TZ.]+)/i)
  if (match) {
    const resetTime = new Date(match[1])
    const diff = resetTime.getTime() - Date.now()
    if (diff > 0) {
      return diff + 5_000 // 5s safety margin
    }
  }
  return 30 * 60 * 1_000 // Fallback to 30 minutes
}

/**
 * Attempts client.login() with exponential backoff on transient network errors.
 * Delay schedule: 5 s → 10 s → 20 s → … capped at 120 s.
 * Non-network errors are rethrown immediately so start() can exit cleanly.
 */
async function loginWithRetry(attempt = 0): Promise<void> {
  try {
    await client.login(DISCORD_TOKEN)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)

    // Discord daily session identification limit exhausted (often 1000 per 24 hours).
    // Sleep through the reset period instead of crashing the process to avoid PM2 infinite restart loops.
    if (msg.includes('sessions remaining') || msg.includes('Not enough sessions')) {
      const waitMs = getSessionWaitTime(msg)
      const waitMins = Math.ceil(waitMs / 60_000)
      logger.error(
        `[Startup] Discord daily session limit exhausted. Resets in ${waitMins} minutes. Sleeping through cooldown...`,
      )

      const checkInterval = 5 * 60 * 1_000 // log status every 5 minutes
      let elapsed = 0
      while (elapsed < waitMs) {
        const remainingMins = Math.ceil((waitMs - elapsed) / 60_000)
        logger.info(`[Startup] Session limit cooldown status: ${remainingMins} minutes remaining.`)
        const chunk = Math.min(checkInterval, waitMs - elapsed)
        await sleep(chunk)
        elapsed += chunk
      }

      logger.info('[Startup] Cooldown finished, retrying Discord login...')
      return loginWithRetry(0)
    }

    if (isNetworkError(err)) {
      const delaySec = Math.min(5 * 2 ** attempt, 120)
      logger.warn(
        `[Startup] Discord login failed (network error, attempt ${attempt + 1}) — retrying in ${delaySec}s`,
      )
      logger.debug('[Startup] Login failure detail:', err)
      await sleep(delaySec * 1_000)
      return loginWithRetry(attempt + 1)
    }
    // Non-network error (bad token, auth rejected, etc.) — propagate immediately.
    throw err
  }
}

// An uncaught exception leaves the process in an undefined state — continuing
// risks operating on corrupted in-memory state (active streams, buffers). Shut
// down cleanly and let the process manager (pm2) restart us fresh.
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error)
  shutdown('uncaughtException', 1)
})

start()
