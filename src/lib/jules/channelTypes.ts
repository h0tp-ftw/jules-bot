import type { ThreadChannel, TextChannel } from 'discord.js'

// A Discord thread or text channel that can host a Jules session stream.
export type JulesDiscordChannel = ThreadChannel | TextChannel
