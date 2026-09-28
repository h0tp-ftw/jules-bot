import type { ThreadChannel, TextChannel, DMChannel } from 'discord.js'

// A Discord thread, text channel, or DM channel that can host a Jules session stream.
export type JulesDiscordChannel = ThreadChannel | TextChannel | DMChannel
