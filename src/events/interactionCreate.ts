import { Events, type Interaction } from 'discord.js'
import { MESSAGES } from '../config.js'
import { hasPermission } from '../lib/utils/permissions.js'
import type { StreamManager } from '../lib/streams/StreamManager.js'
import { handleButtonInteraction } from './interactions/buttons.js'
import { handleSelectMenuInteraction } from './interactions/selects.js'
import { handleModalSubmitInteraction } from './interactions/modals.js'

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction, streamManager: StreamManager) {
    if (interaction.isChatInputCommand()) {
      // Chat input commands are handled separately or via centralized router if needed
      return
    }

    if (
      !interaction.isButton() &&
      !interaction.isStringSelectMenu() &&
      !interaction.isModalSubmit()
    )
      return

    // Check permission. hasPermission resolves to an object, so a bare
    // `!await hasPermission(...)` is ALWAYS false (objects are truthy) — which
    // previously let any user who could see the buttons/menus drive plan
    // approval and repo/branch selection regardless of the allowlist. Destructure
    // `authorized` like the other call sites (index.ts, messageCreate.ts).
    const { authorized } = await hasPermission(
      interaction.member,
      interaction.user,
      interaction.channel,
    )
    if (!authorized) {
      await interaction.reply({
        content: MESSAGES.errors.no_permission_interaction,
        ephemeral: true,
      })
      return
    }

    if (interaction.isButton()) {
      await handleButtonInteraction(interaction, streamManager)
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenuInteraction(interaction, streamManager)
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmitInteraction(interaction, streamManager)
    }
  },
}
