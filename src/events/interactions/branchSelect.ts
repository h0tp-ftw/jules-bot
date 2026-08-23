import type { Messages } from '../../strings.js'
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js'
import { t } from '../../strings.js'

/**
 * Builds the branch-selection dropdown row for a repo. Lists the default branch
 * first (when present), then the remaining branches; if they would exceed
 * Discord's 25-option cap, trims and appends Search/Custom entries.
 */
export function buildBranchSelectRow(
  threadId: string,
  repoName: string,
  branches: string[],
  defaultBranch: string,
  messages: Messages,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options: StringSelectMenuOptionBuilder[] = []

  let hasDefault = false
  if (defaultBranch && branches.includes(defaultBranch)) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(t(messages.setup.default_branch_option, { branch: defaultBranch }))
        .setValue(defaultBranch),
    )
    hasDefault = true
  }

  const regularBranches = hasDefault ? branches.filter((b) => b !== defaultBranch) : branches

  // If the default + regular branches exceed Discord's 25-option cap, trim and
  // leave room for the Search and Custom entries.
  const needsSearch = regularBranches.length + (hasDefault ? 1 : 0) > 25

  if (needsSearch) {
    const maxRegularSlots = 25 - (hasDefault ? 1 : 0) - 2
    const displayBranches = regularBranches.slice(0, maxRegularSlots)
    for (const b of displayBranches) {
      options.push(new StringSelectMenuOptionBuilder().setLabel(b).setValue(b))
    }
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(messages.setup.search_branches_option)
        .setValue('search-branch-prompt'),
      new StringSelectMenuOptionBuilder()
        .setLabel(messages.setup.custom_branch_option)
        .setValue('custom-branch-input'),
    )
  } else {
    for (const b of regularBranches) {
      options.push(new StringSelectMenuOptionBuilder().setLabel(b).setValue(b))
    }
  }

  const branchSelect = new StringSelectMenuBuilder()
    .setCustomId(`select-branch:${threadId}:${repoName}`)
    .setPlaceholder(messages.setup.branch_select_placeholder)
    .addOptions(options)

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(branchSelect)
}
