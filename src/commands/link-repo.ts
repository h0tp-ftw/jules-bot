import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js'
import { prisma } from '../config'

export default {
  data: new SlashCommandBuilder()
    .setName('link-repo')
    .setDescription('Link a GitHub repository to this server as the default for Jules diagnostic sessions')
    .addStringOption((option) =>
      option
        .setName('repository')
        .setDescription('GitHub repository in owner/repo format (e.g. facebook/react)')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true })
      return
    }

    const repository = interaction.options.getString('repository', true)

    // Basic format validation: owner/repo
    const parts = repository.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      await interaction.reply({
        content: '❌ Invalid repository format. Please use `owner/repo` format (e.g., `facebook/react`).',
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
        content: `✅ **Successfully linked repository \`${repository}\` to this server!** Jules will now analyze this repository for new debug threads.`,
      })
    } catch (err) {
      console.error('Failed to link repository:', err)
      await interaction.reply({ content: '❌ Failed to link repository in the database.', ephemeral: true })
    }
  },
}
