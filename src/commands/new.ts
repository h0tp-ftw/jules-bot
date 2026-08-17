import { logger } from '../lib/utils/logger.js'
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ChannelType,
} from 'discord.js'
import { prisma, getEffectiveConfig, MESSAGES, YAML_GUILDS } from '../config.js'
import { t } from '../strings.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import {
  runJulesStream,
  activeStreams,
  scheduleJulesRequest,
} from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'

export default {
  data: new SlashCommandBuilder()
    .setName('new')
    .setDescription(MESSAGES.commands.new_description)
    .addStringOption((option) =>
      option
        .setName('prompt')
        .setDescription(MESSAGES.commands.new_prompt_option_description)
        .setRequired(false),
    ),
  async execute(interaction: ChatInputCommandInteraction, streamManager: StreamManager) {
    if (!interaction.guildId) {
      await interaction.reply({ content: MESSAGES.errors.guild_only, ephemeral: true })
      return
    }

    const channel = interaction.channel
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({
        content: MESSAGES.commands.new_invalid_channel,
        ephemeral: true,
      })
      return
    }

    const initialPrompt = interaction.options.getString('prompt')?.trim()

    // 1. Teardown existing session
    const existingSession = await prisma.debugSession.findUnique({
      where: { threadId: channel.id },
    })

    if (existingSession) {
      activeStreams.delete(channel.id)
      await prisma.debugSession.delete({
        where: { threadId: channel.id },
      })
      logger.info(
        `[Command: /new] Cleared session ${existingSession.julesSessionId} for channel ${channel.id}`,
      )
    }

    const yamlGuild = YAML_GUILDS[interaction.guildId]
    const dbConfig = await prisma.guildConfig.findUnique({
      where: { guildId: interaction.guildId },
    })
    const dbDefaultRepo = dbConfig?.defaultRepo || yamlGuild?.default_repo || undefined
    const channelConfig = getEffectiveConfig(channel as any, interaction.member, dbDefaultRepo)
    const effectiveRepo = channelConfig.default_repo

    if (!initialPrompt) {
      const botEmoji = channelConfig.bot_emoji || '🐙'
      await interaction.reply({
        content: t(channelConfig.messages.commands.new_session_reset_ready, {
          emoji: botEmoji,
          repo: effectiveRepo || 'default repo',
        }),
      })
      return
    }

    // 2. If prompt is provided, initialize new session immediately
    if (!effectiveRepo) {
      await interaction.reply({
        content: channelConfig.messages.commands.new_no_repo,
        ephemeral: true,
      })
      return
    }

    const branchName = channelConfig.default_branch || 'main'
    const botEmoji = channelConfig.bot_emoji || '🐙'

    await interaction.deferReply()

    try {
      const authorNickname =
        interaction.member && 'displayName' in interaction.member
          ? (interaction.member as any).displayName
          : interaction.user.username

      const metadataTemplate =
        channelConfig.messages.prompts.metadata_header_with_channel ||
        channelConfig.messages.prompts.metadata_header

      const promptWithMetadata = t(metadataTemplate, {
        nickname: authorNickname,
        username: interaction.user.username,
        id: interaction.user.id,
        message_id: interaction.id,
        time: new Date().toISOString(),
        reply_info: '',
        channel: 'name' in channel ? (channel as any).name : 'chat',
        content: initialPrompt,
      })

      const session = await scheduleJulesRequest(() =>
        JulesClient.createSession({
          prompt: promptWithMetadata,
          repo: effectiveRepo,
          branch: branchName,
          title: 'name' in channel ? (channel as any).name : 'New Session',
          thread: channel,
          member: interaction.member,
        }),
      )

      await prisma.debugSession.create({
        data: {
          threadId: channel.id,
          guildId: interaction.guildId,
          julesSessionId: session.id,
          repoName: effectiveRepo,
          deliveryCursorInitialized: true,
        },
      })

      const isChatbot = channel.type === ChannelType.GuildText

      void runJulesStream(session.id, channel as any, streamManager, undefined, undefined, {
        chatbotMode: isChatbot,
      }).catch((err) => {
        logger.error(`[/new] Stream failed for channel ${channel.id}, session ${session.id}:`, err)
      })

      await interaction.editReply({
        content:
          t(channelConfig.messages.commands.new_session_initializing, {
            emoji: botEmoji,
            repo: effectiveRepo,
            branch: branchName,
          }) + `\n\n> **${interaction.user.username}:** ${initialPrompt}`,
      })
    } catch (err) {
      logger.error(`[/new] Failed to initialize new session for channel ${channel.id}:`, err)
      await interaction.editReply({
        content: channelConfig.messages.commands.new_session_failed,
      })
    }
  },
}
