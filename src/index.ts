import { Client, GatewayIntentBits, Collection, REST, Routes, Events } from 'discord.js'
import { DISCORD_TOKEN, prisma } from './config.js'
import linkRepoCmd from './commands/link-repo.js'
import setupForumCmd from './commands/setup-forum.js'
import threadCreateEvt from './events/threadCreate.js'
import messageCreateEvt from './events/messageCreate.js'
import interactionCreateEvt from './events/interactionCreate.js'
import { StreamManager } from './lib/streams/StreamManager.js'

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
    // Check permission
    if (!hasPermission(interaction.member, interaction.user)) {
      await interaction.reply({ content: '❌ **You do not have permission to run bot commands.**', ephemeral: true })
      return
    }

    const command = commands.get(interaction.commandName)
    if (!command) return

    try {
      await command.execute(interaction)
    } catch (err) {
      console.error(err)
      await interaction.reply({ content: '❌ There was an error executing this command!', ephemeral: true })
    }
  } else {
    // Pass other interactions (buttons) to interactionCreate event
    await interactionCreateEvt.execute(interaction, streamManager)
  }
})

client.once('ready', async () => {
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
