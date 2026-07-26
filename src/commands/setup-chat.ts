import { logger } from '../lib/utils/logger.js'
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js'
import { prisma, MESSAGES } from '../config.js'
import { t } from '../strings.js'

export default {
  data: new SlashCommandBuilder()
    .setName('setup-chat')
    .setDescription(MESSAGES.commands.setup_chat_description)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription(MESSAGES.commands.setup_chat_option_description)
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: MESSAGES.errors.guild_only, ephemeral: true })
      return
    }

    const channel = interaction.options.getChannel('channel', true)

    try {
      const config = await prisma.guildConfig.findUnique({
        where: { guildId: interaction.guildId },
      })

      await prisma.guildConfig.upsert({
        where: { guildId: interaction.guildId },
        update: { chatChannelId: channel.id },
        create: {
          guildId: interaction.guildId,
          defaultRepo: config?.defaultRepo || '',
          chatChannelId: channel.id,
        },
      })

      await interaction.reply({
        content: t(MESSAGES.commands.setup_chat_success, { channel: channel.id }),
      })
    } catch (err) {
      logger.error('Failed to setup chatbot channel:', err)
      await interaction.reply({ content: MESSAGES.commands.setup_chat_failed, ephemeral: true })
    }
  },
}
