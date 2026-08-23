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
import setupChatCmd from './commands/setup-chat.js'
import approveCmd from './commands/approve.js'
import newCmd from './commands/new.js'
import threadCreateEvt from './events/threadCreate.js'
import messageCreateEvt from './events/messageCreate.js'
import interactionCreateEvt from './events/interactionCreate.js'
import { StreamManager } from './lib/streams/StreamManager.js'
import { initPreWarmedPools } from './lib/jules/PreWarmedManager.js'
import { rehydrateActiveStreams } from './lib/jules/orchestrator.js'
import { startHealthServer } from './lib/health.js'
import { loginWithRetry } from './startup/login.js'
import { setupProcessLifecycle } from './startup/shutdown.js'

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
commands.set(setupChatCmd.data.name, setupChatCmd)
commands.set(approveCmd.data.name, approveCmd)
commands.set(newCmd.data.name, newCmd)

import { hasPermission } from './lib/utils/permissions.js'

// Register events
client.on(Events.ThreadCreate, (thread) => {
  void threadCreateEvt.execute(thread, streamManager).catch((err) => {
    logger.error(`[Event: ThreadCreate] Unhandled failure for thread ${thread.id}:`, err)
  })
})

client.on(Events.MessageCreate, (message) => {
  void messageCreateEvt.execute(message, streamManager).catch((err) => {
    logger.error(`[Event: MessageCreate] Unhandled failure for message ${message.id}:`, err)
  })
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
  // inviting the bot. A guild needs a repo plus at least one destination: a
  // forum (/setup-forum), a shared text channel (/setup-chat), or both.
  try {
    const configs = await prisma.guildConfig.findMany()
    const byId = new Map(configs.map((c) => [c.guildId, c]))
    for (const guild of client.guilds.cache.values()) {
      const yamlGuild = YAML_GUILDS[guild.id] || {}
      const cfg = byId.get(guild.id)
      const repo = yamlGuild.default_repo || cfg?.defaultRepo
      const forum = yamlGuild.forum_channel_id || cfg?.forumChannelId
      const chat = yamlGuild.chat_channel_id || cfg?.chatChannelId
      const missing: string[] = []
      if (!forum && !chat) {
        missing.push('forum or chatbot channel (/setup-forum or /setup-chat)')
      }
      if (!repo) missing.push('repo (/link-repo)')
      if (missing.length) {
        logger.warn(`[Setup] "${guild.name}" not ready — still needs: ${missing.join(' + ')}`)
      } else {
        const destinations = [
          forum ? `forum channel ${forum}` : '',
          chat ? `chatbot channel ${chat}` : '',
        ].filter(Boolean)
        logger.info(`[Setup] "${guild.name}" ready — repo ${repo}, ${destinations.join(' + ')}`)
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

// Graceful shutdown + process-level resilience handlers
setupProcessLifecycle({ client, streamManager })

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

    await loginWithRetry(client, DISCORD_TOKEN)
  } catch (err) {
    logger.error('Error starting bot:', err)
    process.exit(1)
  }
}

start()
