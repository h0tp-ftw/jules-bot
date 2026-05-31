import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js'
import { prisma } from '../config.js'

export default {
  data: new SlashCommandBuilder()
    .setName('setup-forum')
    .setDescription('Set the designated Forum channel where Jules will monitor debug threads')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('The Forum channel to monitor')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true })
      return
    }

    const channel = interaction.options.getChannel('channel', true)

    try {
      const config = await prisma.guildConfig.findUnique({
        where: { guildId: interaction.guildId },
      })

      await prisma.guildConfig.upsert({
        where: { guildId: interaction.guildId },
        update: { forumChannelId: channel.id },
        create: {
          guildId: interaction.guildId,
          defaultRepo: config?.defaultRepo || '',
          forumChannelId: channel.id,
        },
      })

      await interaction.reply({
        content: `✅ **Successfully set debug forum channel to <#${channel.id}>!** Any new threads created here will initialize a Jules session.`,
      })
    } catch (err) {
      console.error('Failed to setup forum channel:', err)
      await interaction.reply({ content: '❌ Failed to save forum channel configuration in the database.', ephemeral: true })
    }
  },
}
