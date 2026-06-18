import { Client, GatewayIntentBits, Collection, REST, Routes, Events, ActivityType, PresenceStatusData } from 'discord.js'
import { DISCORD_TOKEN, prisma, yamlConfig, MESSAGES } from './config.js'
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

if (!DISCORD_TOKEN || DISCORD_TOKEN === 'YOUR_DISCORD_TOKEN') {
  console.error('Error: DISCORD_TOKEN is not configured in .env file.')
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
    const { authorized } = await hasPermission(interaction.member, interaction.user, interaction.channel)
    if (!authorized) {
      await interaction.reply({ content: MESSAGES.errors.no_permission_commands, ephemeral: true })
      return
    }

    const command = commands.get(interaction.commandName)
    if (!command) return

    try {
      await command.execute(interaction, streamManager)
    } catch (err: any) {
      console.error(err)
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
  console.log(`🐙 Bot logged in as ${client.user?.tag}`)

  // Automatically register slash commands globally
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    const commandData = Array.from(commands.values()).map((cmd) => cmd.data.toJSON())

    console.log('Refreshing application (/) commands...')
    await rest.put(Routes.applicationCommands(client.user!.id), {
      body: commandData,
    })
    console.log('Successfully reloaded application (/) commands.')
  } catch (error) {
    console.error('Failed to register application commands:', error)
  }

  // Initialize pre-warmed pools
  initPreWarmedPools().catch((err) => {
    console.error('Failed to initialize pre-warmed pools:', err)
  })

  // Rehydrate active streams
  rehydrateActiveStreams(client, streamManager).catch((err) => {
    console.error('Failed to rehydrate active streams:', err)
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
      activities: presence.activity ? [{
        name: type === ActivityType.Custom ? MESSAGES.misc.custom_status_name : presence.activity,
        state: type === ActivityType.Custom ? presence.activity : undefined,
        type: type,
        url: presence.url
      }] : []
    })
  }
})

// Connect to SQLite and Login bot
async function start() {
  try {
    // Verify DB connection
    await prisma.$connect()
    console.log('Connected to Database.')
    await client.login(DISCORD_TOKEN)
  } catch (err) {
    console.error('Error starting bot:', err)
    process.exit(1)
  }
}

// Global error handlers to prevent bot from crashing on temporary network dropouts
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

start()
