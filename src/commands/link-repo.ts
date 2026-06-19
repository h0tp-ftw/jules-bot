import { logger } from '../lib/utils/logger.js'
import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js'
import { prisma, MESSAGES } from '../config.js'
import { t } from '../strings.js'

export default {
  data: new SlashCommandBuilder()
    .setName('link-repo')
    .setDescription(MESSAGES.commands.link_repo_description)
    .addStringOption((option) =>
      option
        .setName('repository')
        .setDescription(MESSAGES.commands.link_repo_option_description)
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: MESSAGES.errors.guild_only, ephemeral: true })
      return
    }

    const repository = interaction.options.getString('repository', true)

    // Basic format validation: owner/repo
    const parts = repository.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      await interaction.reply({
        content: MESSAGES.commands.link_repo_invalid_format,
        ephemeral: true,
      })
      return
    }

    try {
      await prisma.guildConfig.upsert({
        where: { guildId: interaction.guildId },
        update: { defaultRepo: repository },
        create: {
          guildId: interaction.guildId,
          defaultRepo: repository,
        },
      })

      await interaction.reply({
        content: t(MESSAGES.commands.link_repo_success, { repo: repository }),
      })
    } catch (err) {
      logger.error('Failed to link repository:', err)
      await interaction.reply({ content: MESSAGES.commands.link_repo_failed, ephemeral: true })
    }
  },
}
