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
import { resolveOverrideLayers, type ConfigLayer } from './layerHierarchy.js'

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

function resolveScalar<T>(layers: ConfigLayer[], key: string, fallback: T): T {
  for (let i = layers.length - 1; i >= 0; i--) {
    const val = layers[i]?.[key]
    if (val !== undefined) return val as T
  }
  return fallback
}

function resolveBoolean(layers: ConfigLayer[], key: string, fallback: boolean): boolean {
  for (let i = layers.length - 1; i >= 0; i--) {
    const val = layers[i]?.[key]
    if (typeof val === 'boolean') return val
  }
  return fallback
}

function resolveAccessControl(layers: ConfigLayer[]) {
  const result = {
    allow_all: ALLOW_ALL,
    allowed_users: ALLOWED_USERS,
    allowed_roles: ALLOWED_ROLES,
    silent: ALLOW_SILENT,
  }
  for (const layer of layers) {
    const ac = layer.access_control
    if (!ac || typeof ac !== 'object') continue
    if (typeof ac.allow_all === 'boolean') result.allow_all = ac.allow_all
    if (typeof ac.silent === 'boolean') result.silent = ac.silent
    if (Array.isArray(ac.allowed_users)) result.allowed_users = ac.allowed_users.map(String)
    if (Array.isArray(ac.allowed_roles)) result.allowed_roles = ac.allowed_roles.map(String)
  }
  return result
}

function resolveNudge(layers: ConfigLayer[]) {
  const raw = layers.reduce((acc, layer) => ({ ...acc, ...(layer.nudge || {}) }), { ...NUDGE })
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : NUDGE.enabled,
    after_minutes:
      typeof raw.after_minutes === 'number' && raw.after_minutes > 0
        ? raw.after_minutes
        : NUDGE.after_minutes,
    notify_discord:
      typeof raw.notify_discord === 'boolean' ? raw.notify_discord : NUDGE.notify_discord,
    message: typeof raw.message === 'string' && raw.message.trim() ? raw.message : undefined,
    discord_message:
      typeof raw.discord_message === 'string' && raw.discord_message.trim()
        ? raw.discord_message
        : undefined,
  }
}

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
  const { parentOverride, tagOverride, threadOverride, roleOverride, layers } =
    resolveOverrideLayers(thread, member)

  // Merge sub-objects: defaults -> parent channel -> tags -> thread -> roles
  const resolvedAutoReject = layers.reduce<typeof AUTO_REJECT>(
    (acc, l) => ({ ...acc, ...(l.auto_reject || {}) }),
    { ...AUTO_REJECT },
  )
  const resolvedReactions = layers.reduce<Record<string, string>>(
    (acc, l) => ({ ...acc, ...(l.reactions || {}) }),
    { ...REACTIONS },
  )
  const resolvedJulesReactions = layers.reduce<typeof JULES_REACTIONS>(
    (acc, l) => ({ ...acc, ...(l.jules_reactions || {}) }),
    { ...JULES_REACTIONS },
  )
  const resolvedPreWarmed = layers.reduce<typeof PRE_WARMED_SESSIONS>(
    (acc, l) => ({ ...acc, ...(l.pre_warmed_sessions || {}) }),
    { ...PRE_WARMED_SESSIONS },
  )
  const resolvedAccessControl = resolveAccessControl(layers)
  const resolvedNudge = resolveNudge(layers)

  // Resolve base repo and branch
  let baseDefaultRepo = yamlConfig.default_repo || dbDefaultRepo
  let baseDefaultBranch = yamlConfig.default_branch

  if (thread && thread.guildId) {
    const yamlGuild = YAML_GUILDS[thread.guildId]
    if (yamlGuild?.default_repo) {
      baseDefaultRepo = yamlGuild.default_repo
    }
    if ((yamlGuild as any)?.default_branch) {
      baseDefaultBranch = (yamlGuild as any).default_branch
    }
  }

  // Resolve user-facing strings
  const hasCustomMessages = Boolean(
    parentOverride.messages ||
      tagOverride.messages ||
      threadOverride.messages ||
      roleOverride.messages,
  )

  const resolvedMessages: Messages = hasCustomMessages
    ? (deepMergeMessages(
        MESSAGES,
        parentOverride.messages || {},
        tagOverride.messages || {},
        threadOverride.messages || {},
        roleOverride.messages || {},
      ) as Messages)
    : MESSAGES

  return {
    diagnostic_prompt: resolveScalar(layers, 'diagnostic_prompt', DIAGNOSTIC_PROMPT),
    access_control: resolvedAccessControl,
    reactions: resolvedReactions,
    auto_reject: resolvedAutoReject,
    jules_reactions: resolvedJulesReactions,
    nudge: resolvedNudge,
    pre_warmed_sessions: resolvedPreWarmed,
    agents_personality: resolveScalar(layers, 'agents_personality', AGENT_PERSONALITY),
    soul_personality: resolveScalar(layers, 'soul_personality', SOUL_PERSONALITY),
    interactive_selection: resolveBoolean(layers, 'interactive_selection', INTERACTIVE_SELECTION),
    default_repo: resolveScalar(layers, 'default_repo', baseDefaultRepo),
    default_branch: resolveScalar(layers, 'default_branch', baseDefaultBranch),
    ignore_prefix: resolveScalar(layers, 'ignore_prefix', yamlConfig.ignore_prefix),
    bot_emoji: resolveScalar(layers, 'bot_emoji', BOT_EMOJI),
    typing_indicator_mode: resolveScalar(
      layers,
      'typing_indicator_mode',
      yamlConfig.typing_indicator_mode || 'until_response',
    ),
    messages: resolvedMessages,
    bootstrap: resolveBoolean(
      layers,
      'bootstrap',
      typeof yamlConfig.bootstrap === 'boolean' ? yamlConfig.bootstrap : true,
    ),
    reply_mode: resolveScalar(layers, 'reply_mode', yamlConfig.reply_mode || 'send'),
    reply_context_mode: normalizeReplyContextMode(
      resolveScalar(layers, 'reply_context_mode', yamlConfig.reply_context_mode),
    ),
  }
}
