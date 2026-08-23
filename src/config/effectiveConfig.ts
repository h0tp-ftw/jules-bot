import { deepMergeMessages, type Messages } from '../strings.js'
import { yamlConfig } from './yaml.js'
import {
  ALLOW_ALL,
  ALLOWED_USERS,
  ALLOWED_ROLES,
  ALLOW_SILENT,
  AUTO_REJECT,
  REACTIONS,
  JULES_REACTIONS,
  NUDGE,
  PRE_WARMED_SESSIONS,
  DIAGNOSTIC_PROMPT,
  INTERACTIVE_SELECTION,
  BOT_EMOJI,
  YAML_GUILDS,
  MESSAGES,
} from './constants.js'
import { AGENT_PERSONALITY, SOUL_PERSONALITY } from './personalities.js'

// Resolve dynamic effective configuration for a given thread or channel
export function getEffectiveConfig(
  thread?: any,
  member?: any,
  dbDefaultRepo?: string,
): {
  diagnostic_prompt: string
  access_control: {
    allow_all: boolean
    allowed_users: string[]
    allowed_roles: string[]
    silent: boolean
  }
  reactions: Record<string, string>
  auto_reject: {
    enabled: boolean
    message: string
  }
  jules_reactions: {
    enabled: boolean
  }
  nudge: {
    enabled: boolean
    after_minutes: number
    notify_discord: boolean
    message?: string
    discord_message?: string
  }
  pre_warmed_sessions: {
    enabled: boolean
    pool_size: number
    pre_warming_prompt: string
  }
  agents_personality?: string
  soul_personality?: string
  interactive_selection: boolean
  default_repo?: string
  default_branch?: string
  ignore_prefix?: string
  bot_emoji: string
  typing_indicator_mode: string
  messages: Messages
  bootstrap: boolean
  reply_mode: 'reply_ping' | 'reply_silent' | 'send'
  reply_context_mode: ReplyContextMode
} {
  const channelsConfig = yamlConfig.channels || {}

  let threadOverride = {}
  let parentOverride = {}

  if (thread) {
    if (thread.id && channelsConfig[thread.id]) {
      threadOverride = channelsConfig[thread.id]
    }
    if (thread.parentId && channelsConfig[thread.parentId]) {
      parentOverride = channelsConfig[thread.parentId]
    }
  }

  // Resolve tag-based overrides from the forum post's applied tags. A post can
  // carry several tags; each `tags:` config key is matched against the thread's
  // applied tag IDs or — when the parent forum is cached — their names, and
  // matches are merged in config-definition order (later keys win), the same
  // way multiple roles accumulate below. All reads are synchronous cache lookups
  // (no network), so this stays safe on the hot stream path.
  let tagOverride: any = {}
  if (thread && Array.isArray(thread.appliedTags) && thread.appliedTags.length > 0) {
    const tagsConfig = yamlConfig.tags || {}
    if (Object.keys(tagsConfig).length > 0) {
      const appliedIds = new Set<string>(thread.appliedTags.map(String))
      const appliedNames = new Set<string>()
      const availableTags = thread.parent?.availableTags
      if (Array.isArray(availableTags)) {
        for (const at of availableTags) {
          if (at && appliedIds.has(String(at.id)) && typeof at.name === 'string') {
            appliedNames.add(at.name)
          }
        }
      }
      for (const [tagKey, tagVal] of Object.entries(tagsConfig)) {
        const matches = appliedIds.has(tagKey) || appliedNames.has(tagKey)
        if (matches && tagVal && typeof tagVal === 'object') {
          tagOverride = {
            ...tagOverride,
            ...tagVal,
            access_control: {
              ...(tagOverride.access_control || {}),
              ...((tagVal as any).access_control || {}),
            },
            reactions: {
              ...(tagOverride.reactions || {}),
              ...((tagVal as any).reactions || {}),
            },
            auto_reject: {
              ...(tagOverride.auto_reject || {}),
              ...((tagVal as any).auto_reject || {}),
            },
            jules_reactions: {
              ...(tagOverride.jules_reactions || {}),
              ...((tagVal as any).jules_reactions || {}),
            },
            nudge: {
              ...(tagOverride.nudge || {}),
              ...((tagVal as any).nudge || {}),
            },
            pre_warmed_sessions: {
              ...(tagOverride.pre_warmed_sessions || {}),
              ...((tagVal as any).pre_warmed_sessions || {}),
            },
            messages: deepMergeMessages(tagOverride.messages || {}, (tagVal as any).messages || {}),
          }
        }
      }
    }
  }

  // Resolve role-based overrides if member is provided
  let roleOverride: any = {}
  if (member && member.roles) {
    const rolesConfig = yamlConfig.roles || {}
    for (const [roleKey, roleVal] of Object.entries(rolesConfig)) {
      let hasRole = false
      if ('cache' in member.roles) {
        hasRole =
          member.roles.cache.has(roleKey) || member.roles.cache.some((r: any) => r.name === roleKey)
      } else if (Array.isArray(member.roles)) {
        hasRole = member.roles.includes(roleKey)
      }

      if (hasRole && roleVal && typeof roleVal === 'object') {
        roleOverride = {
          ...roleOverride,
          ...roleVal,
          access_control: {
            ...(roleOverride.access_control || {}),
            ...((roleVal as any).access_control || {}),
          },
          reactions: {
            ...(roleOverride.reactions || {}),
            ...((roleVal as any).reactions || {}),
          },
          auto_reject: {
            ...(roleOverride.auto_reject || {}),
            ...((roleVal as any).auto_reject || {}),
          },
          jules_reactions: {
            ...(roleOverride.jules_reactions || {}),
            ...((roleVal as any).jules_reactions || {}),
          },
          nudge: {
            ...(roleOverride.nudge || {}),
            ...((roleVal as any).nudge || {}),
          },
          pre_warmed_sessions: {
            ...(roleOverride.pre_warmed_sessions || {}),
            ...((roleVal as any).pre_warmed_sessions || {}),
          },
          messages: deepMergeMessages(roleOverride.messages || {}, (roleVal as any).messages || {}),
        }
      }
    }
  }

  // Deep merge: global values -> parent channel overrides -> tag overrides -> thread-specific overrides -> role overrides
  const resolvedAutoReject = {
    ...AUTO_REJECT,
    ...(parentOverride as any).auto_reject,
    ...(tagOverride as any).auto_reject,
    ...(threadOverride as any).auto_reject,
    ...(roleOverride as any).auto_reject,
  }

  const resolvedReactions = {
    ...REACTIONS,
    ...(parentOverride as any).reactions,
    ...(tagOverride as any).reactions,
    ...(threadOverride as any).reactions,
    ...(roleOverride as any).reactions,
  }

  const resolvedJulesReactions = {
    ...JULES_REACTIONS,
    ...(parentOverride as any).jules_reactions,
    ...(tagOverride as any).jules_reactions,
    ...(threadOverride as any).jules_reactions,
    ...(roleOverride as any).jules_reactions,
  }

  const rawResolvedNudge = {
    ...NUDGE,
    ...(parentOverride as any).nudge,
    ...(tagOverride as any).nudge,
    ...(threadOverride as any).nudge,
    ...(roleOverride as any).nudge,
  }
  const resolvedNudge = {
    enabled:
      typeof rawResolvedNudge.enabled === 'boolean' ? rawResolvedNudge.enabled : NUDGE.enabled,
    after_minutes:
      typeof rawResolvedNudge.after_minutes === 'number' && rawResolvedNudge.after_minutes > 0
        ? rawResolvedNudge.after_minutes
        : NUDGE.after_minutes,
    notify_discord:
      typeof rawResolvedNudge.notify_discord === 'boolean'
        ? rawResolvedNudge.notify_discord
        : NUDGE.notify_discord,
    message:
      typeof rawResolvedNudge.message === 'string' && rawResolvedNudge.message.trim()
        ? rawResolvedNudge.message
        : undefined,
    discord_message:
      typeof rawResolvedNudge.discord_message === 'string' &&
      rawResolvedNudge.discord_message.trim()
        ? rawResolvedNudge.discord_message
        : undefined,
  }

  const resolvedPreWarmed = {
    ...PRE_WARMED_SESSIONS,
    ...(parentOverride as any).pre_warmed_sessions,
    ...(tagOverride as any).pre_warmed_sessions,
    ...(threadOverride as any).pre_warmed_sessions,
    ...(roleOverride as any).pre_warmed_sessions,
  }

  const resolvedAccessControl = {
    allow_all: ALLOW_ALL,
    allowed_users: ALLOWED_USERS,
    allowed_roles: ALLOWED_ROLES,
    silent: ALLOW_SILENT,
  }

  const parentAC = (parentOverride as any).access_control || {}
  const tagAC = (tagOverride as any).access_control || {}
  const threadAC = (threadOverride as any).access_control || {}
  const roleAC = (roleOverride as any).access_control || {}

  if (typeof parentAC.allow_all === 'boolean') resolvedAccessControl.allow_all = parentAC.allow_all
  if (typeof tagAC.allow_all === 'boolean') resolvedAccessControl.allow_all = tagAC.allow_all
  if (typeof threadAC.allow_all === 'boolean') resolvedAccessControl.allow_all = threadAC.allow_all
  if (typeof roleAC.allow_all === 'boolean') resolvedAccessControl.allow_all = roleAC.allow_all

  if (Array.isArray(parentAC.allowed_users))
    resolvedAccessControl.allowed_users = parentAC.allowed_users.map(String)
  if (Array.isArray(tagAC.allowed_users))
    resolvedAccessControl.allowed_users = tagAC.allowed_users.map(String)
  if (Array.isArray(threadAC.allowed_users))
    resolvedAccessControl.allowed_users = threadAC.allowed_users.map(String)
  if (Array.isArray(roleAC.allowed_users))
    resolvedAccessControl.allowed_users = roleAC.allowed_users.map(String)

  if (Array.isArray(parentAC.allowed_roles))
    resolvedAccessControl.allowed_roles = parentAC.allowed_roles.map(String)
  if (Array.isArray(tagAC.allowed_roles))
    resolvedAccessControl.allowed_roles = tagAC.allowed_roles.map(String)
  if (Array.isArray(threadAC.allowed_roles))
    resolvedAccessControl.allowed_roles = threadAC.allowed_roles.map(String)
  if (Array.isArray(roleAC.allowed_roles))
    resolvedAccessControl.allowed_roles = roleAC.allowed_roles.map(String)

  if (typeof parentAC.silent === 'boolean') resolvedAccessControl.silent = parentAC.silent
  if (typeof tagAC.silent === 'boolean') resolvedAccessControl.silent = tagAC.silent
  if (typeof threadAC.silent === 'boolean') resolvedAccessControl.silent = threadAC.silent
  if (typeof roleAC.silent === 'boolean') resolvedAccessControl.silent = roleAC.silent

  const resolvedPrompt =
    (roleOverride as any).diagnostic_prompt ||
    (threadOverride as any).diagnostic_prompt ||
    (tagOverride as any).diagnostic_prompt ||
    (parentOverride as any).diagnostic_prompt ||
    DIAGNOSTIC_PROMPT

  const resolvedAgents =
    (roleOverride as any).agents_personality ||
    (threadOverride as any).agents_personality ||
    (tagOverride as any).agents_personality ||
    (parentOverride as any).agents_personality ||
    AGENT_PERSONALITY

  const resolvedSoul =
    (roleOverride as any).soul_personality ||
    (threadOverride as any).soul_personality ||
    (tagOverride as any).soul_personality ||
    (parentOverride as any).soul_personality ||
    SOUL_PERSONALITY

  const resolvedInteractive =
    typeof (roleOverride as any).interactive_selection === 'boolean'
      ? (roleOverride as any).interactive_selection
      : typeof (threadOverride as any).interactive_selection === 'boolean'
        ? (threadOverride as any).interactive_selection
        : typeof (tagOverride as any).interactive_selection === 'boolean'
          ? (tagOverride as any).interactive_selection
          : typeof (parentOverride as any).interactive_selection === 'boolean'
            ? (parentOverride as any).interactive_selection
            : INTERACTIVE_SELECTION

  // Resolve default_repo and default_branch
  let resolvedDefaultRepo = yamlConfig.default_repo || dbDefaultRepo
  let resolvedDefaultBranch = yamlConfig.default_branch

  if (thread && thread.guildId) {
    const yamlGuild = YAML_GUILDS[thread.guildId]
    if (yamlGuild?.default_repo) {
      resolvedDefaultRepo = yamlGuild.default_repo
    }
    if ((yamlGuild as any)?.default_branch) {
      resolvedDefaultBranch = (yamlGuild as any).default_branch
    }
  }

  // Parent channel override
  if (parentOverride && (parentOverride as any).default_repo) {
    resolvedDefaultRepo = (parentOverride as any).default_repo
  }
  if (parentOverride && (parentOverride as any).default_branch) {
    resolvedDefaultBranch = (parentOverride as any).default_branch
  }

  // Tag override
  if (tagOverride && tagOverride.default_repo) {
    resolvedDefaultRepo = tagOverride.default_repo
  }
  if (tagOverride && tagOverride.default_branch) {
    resolvedDefaultBranch = tagOverride.default_branch
  }

  // Thread override
  if (threadOverride && (threadOverride as any).default_repo) {
    resolvedDefaultRepo = (threadOverride as any).default_repo
  }
  if (threadOverride && (threadOverride as any).default_branch) {
    resolvedDefaultBranch = (threadOverride as any).default_branch
  }

  // Role override
  if (roleOverride && roleOverride.default_repo) {
    resolvedDefaultRepo = roleOverride.default_repo
  }
  if (roleOverride && roleOverride.default_branch) {
    resolvedDefaultBranch = roleOverride.default_branch
  }

  // Resolve ignore_prefix
  let resolvedIgnorePrefix = yamlConfig.ignore_prefix

  if (parentOverride && (parentOverride as any).ignore_prefix) {
    resolvedIgnorePrefix = (parentOverride as any).ignore_prefix
  }
  if (tagOverride && tagOverride.ignore_prefix) {
    resolvedIgnorePrefix = tagOverride.ignore_prefix
  }
  if (threadOverride && (threadOverride as any).ignore_prefix) {
    resolvedIgnorePrefix = (threadOverride as any).ignore_prefix
  }
  if (roleOverride && roleOverride.ignore_prefix) {
    resolvedIgnorePrefix = roleOverride.ignore_prefix
  }

  // Resolve bot_emoji
  let resolvedBotEmoji = BOT_EMOJI

  if (parentOverride && (parentOverride as any).bot_emoji) {
    resolvedBotEmoji = (parentOverride as any).bot_emoji
  }
  if (tagOverride && tagOverride.bot_emoji) {
    resolvedBotEmoji = tagOverride.bot_emoji
  }
  if (threadOverride && (threadOverride as any).bot_emoji) {
    resolvedBotEmoji = (threadOverride as any).bot_emoji
  }
  if (roleOverride && roleOverride.bot_emoji) {
    resolvedBotEmoji = roleOverride.bot_emoji
  }

  // Resolve typing_indicator_mode
  let resolvedTypingMode = yamlConfig.typing_indicator_mode || 'until_response'

  if (parentOverride && (parentOverride as any).typing_indicator_mode) {
    resolvedTypingMode = (parentOverride as any).typing_indicator_mode
  }
  if (tagOverride && tagOverride.typing_indicator_mode) {
    resolvedTypingMode = tagOverride.typing_indicator_mode
  }
  if (threadOverride && (threadOverride as any).typing_indicator_mode) {
    resolvedTypingMode = (threadOverride as any).typing_indicator_mode
  }
  if (roleOverride && roleOverride.typing_indicator_mode) {
    resolvedTypingMode = roleOverride.typing_indicator_mode
  }

  // Resolve bootstrap
  let resolvedBootstrap = typeof yamlConfig.bootstrap === 'boolean' ? yamlConfig.bootstrap : true

  if (parentOverride && typeof (parentOverride as any).bootstrap === 'boolean') {
    resolvedBootstrap = (parentOverride as any).bootstrap
  }
  if (tagOverride && typeof tagOverride.bootstrap === 'boolean') {
    resolvedBootstrap = tagOverride.bootstrap
  }
  if (threadOverride && typeof (threadOverride as any).bootstrap === 'boolean') {
    resolvedBootstrap = (threadOverride as any).bootstrap
  }
  if (roleOverride && typeof roleOverride.bootstrap === 'boolean') {
    resolvedBootstrap = roleOverride.bootstrap
  }

  // Resolve reply_mode
  let resolvedReplyMode: 'reply_ping' | 'reply_silent' | 'send' = yamlConfig.reply_mode || 'send'

  if (parentOverride && (parentOverride as any).reply_mode) {
    resolvedReplyMode = (parentOverride as any).reply_mode
  }
  if (tagOverride && tagOverride.reply_mode) {
    resolvedReplyMode = tagOverride.reply_mode
  }
  if (threadOverride && (threadOverride as any).reply_mode) {
    resolvedReplyMode = (threadOverride as any).reply_mode
  }
  if (roleOverride && roleOverride.reply_mode) {
    resolvedReplyMode = roleOverride.reply_mode
  }

  // Resolve reply_context_mode
  let rawReplyContextMode: string | undefined = yamlConfig.reply_context_mode

  if (parentOverride && (parentOverride as any).reply_context_mode !== undefined) {
    rawReplyContextMode = (parentOverride as any).reply_context_mode
  }
  if (tagOverride && tagOverride.reply_context_mode !== undefined) {
    rawReplyContextMode = tagOverride.reply_context_mode
  }
  if (threadOverride && (threadOverride as any).reply_context_mode !== undefined) {
    rawReplyContextMode = (threadOverride as any).reply_context_mode
  }
  if (roleOverride && roleOverride.reply_context_mode !== undefined) {
    rawReplyContextMode = roleOverride.reply_context_mode
  }
  const resolvedReplyContextMode = normalizeReplyContextMode(rawReplyContextMode)

  // Resolve user-facing strings: code defaults <- global YAML <- parent channel
  // <- tag <- thread <- role. Each layer only needs to supply the keys it changes.
  // MESSAGES already folds DEFAULT_MESSAGES <- global YAML once at module load,
  // so only the per-context layers need merging here. When a channel/thread/role
  // supplies no `messages:` overrides (the common case) we return the shared
  // MESSAGES object directly and skip deep-cloning the whole ~140-key catalog —
  // getEffectiveConfig runs on the hot stream path (per activity/reaction).
  const parentMessages = (parentOverride as any).messages
  const tagMessages = (tagOverride as any).messages
  const threadMessages = (threadOverride as any).messages
  const roleMessages = (roleOverride as any).messages
  const resolvedMessages: Messages =
    parentMessages || tagMessages || threadMessages || roleMessages
      ? (deepMergeMessages(
          MESSAGES,
          parentMessages || {},
          tagMessages || {},
          threadMessages || {},
          roleMessages || {},
        ) as Messages)
      : MESSAGES

  return {
    diagnostic_prompt: resolvedPrompt,
    access_control: resolvedAccessControl,
    reactions: resolvedReactions,
    auto_reject: resolvedAutoReject,
    jules_reactions: resolvedJulesReactions,
    nudge: resolvedNudge,
    pre_warmed_sessions: resolvedPreWarmed,
    agents_personality: resolvedAgents,
    soul_personality: resolvedSoul,
    interactive_selection: resolvedInteractive,
    default_repo: resolvedDefaultRepo,
    default_branch: resolvedDefaultBranch,
    ignore_prefix: resolvedIgnorePrefix,
    bot_emoji: resolvedBotEmoji,
    typing_indicator_mode: resolvedTypingMode,
    messages: resolvedMessages,
    bootstrap: resolvedBootstrap,
    reply_mode: resolvedReplyMode,
    reply_context_mode: resolvedReplyContextMode,
  }
}

export type ReplyContextMode = 'message_id' | 'full_message' | 'none'

export function normalizeReplyContextMode(mode?: unknown): ReplyContextMode {
  if (typeof mode !== 'string') return 'message_id'
  const normalized = mode.trim().toLowerCase()
  if (
    normalized === 'full_message' ||
    normalized === 'full' ||
    normalized === 'quote' ||
    normalized === 'snippet'
  ) {
    return 'full_message'
  }
  if (
    normalized === 'none' ||
    normalized === 'off' ||
    normalized === 'disabled' ||
    normalized === 'false'
  ) {
    return 'none'
  }
  return 'message_id'
}
