import { DEFAULT_MESSAGES, deepMergeMessages, type Messages } from '../strings.js'
import { yamlConfig } from './yaml.js'

// Centralized user-facing strings: code defaults (src/strings.ts) overlaid with
// any global `messages:` overrides from YAML. Use this where there is no thread
// context; for per-channel/thread/role resolution use getEffectiveConfig().messages.
export const MESSAGES: Messages = deepMergeMessages(
  DEFAULT_MESSAGES,
  yamlConfig.messages || {},
) as Messages

// Diagnostic Prompt for Google Jules
export const DIAGNOSTIC_PROMPT =
  yamlConfig.diagnostic_prompt ||
  `You are a diagnostic help agent talking to a non-technical user. Explain bugs and issues in simple, everyday terms. Avoid developer jargon, deep technical code details, and raw code blocks unless explicitly requested. Use clear analogies to explain what is wrong. Do NOT modify the codebase, write code changes, or create pull requests unless a program-level bug is identified and the user explicitly asks for a code fix. Keep conversation interactive, clear, and friendly.`

export const BOT_EMOJI = typeof yamlConfig.bot_emoji === 'string' ? yamlConfig.bot_emoji : '🐙'

// Access Control config
const accessControl = yamlConfig.access_control || {}
export const ALLOW_ALL =
  typeof accessControl.allow_all === 'boolean'
    ? accessControl.allow_all
    : process.env.ALLOW_ALL !== 'false'

export const ALLOWED_USERS: string[] = Array.isArray(accessControl.allowed_users)
  ? accessControl.allowed_users.map(String)
  : (process.env.ALLOWED_USERS || '')
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean)

export const ALLOWED_ROLES: string[] = Array.isArray(accessControl.allowed_roles)
  ? accessControl.allowed_roles.map(String)
  : (process.env.ALLOWED_ROLES || '')
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean)

export const ALLOW_SILENT = typeof accessControl.silent === 'boolean' ? accessControl.silent : false

// Reactions mapping config
export const DEFAULT_REACTIONS = {
  queued: '⏳',
  in_progress: '⚙️',
  responded: '💬',
  awaiting_plan_approval: '📋',
  paused: '⏸️',
  completed: '✅',
  failed: '❌',
}

export const REACTIONS: Record<string, string> = {
  ...DEFAULT_REACTIONS,
  ...(yamlConfig.reactions || {}),
}

// Guild override mappings from YAML
export const YAML_GUILDS: Record<
  string,
  {
    default_repo?: string
    default_branch?: string
    forum_channel_id?: string
    chat_channel_id?: string
  }
> = yamlConfig.guilds || {}

// API Keys and Tokens
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || ''
export const JULES_API_KEY = process.env.JULES_API_KEY || ''

// Auto-reject configuration
const autoReject = yamlConfig.auto_reject || {}
export const AUTO_REJECT = {
  enabled: typeof autoReject.enabled === 'boolean' ? autoReject.enabled : false,
  message: typeof autoReject.message === 'string' ? autoReject.message : '',
}

// Jules-authored reactions: when enabled, the session prompt teaches Jules the
// `[[react:emoji]]` marker protocol, and the orchestrator parses those markers
// back out into real Discord reactions on the user's message. Off by default.
const julesReactions = yamlConfig.jules_reactions || {}
export const JULES_REACTIONS = {
  enabled: typeof julesReactions.enabled === 'boolean' ? julesReactions.enabled : false,
}

// One-shot reminder sent to Jules when a dispatched Discord turn has not received
// a user-facing response within the configured interval. Opt-in by default.
const nudge = yamlConfig.nudge || {}
export const NUDGE = {
  enabled: typeof nudge.enabled === 'boolean' ? nudge.enabled : false,
  after_minutes:
    typeof nudge.after_minutes === 'number' && nudge.after_minutes > 0 ? nudge.after_minutes : 5,
  notify_discord: typeof nudge.notify_discord === 'boolean' ? nudge.notify_discord : true,
  message: typeof nudge.message === 'string' && nudge.message.trim() ? nudge.message : undefined,
  discord_message:
    typeof nudge.discord_message === 'string' && nudge.discord_message.trim()
      ? nudge.discord_message
      : undefined,
}

// Centralized Jules activity polling. Active work stays responsive; sessions that
// have replied / are awaiting input / completed fall back to a slow polling lane
// for a bounded grace period, then stop generating API traffic entirely until a
// new Discord action wakes them.
const julesPolling = yamlConfig.jules_polling || {}
const positiveNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
export const JULES_POLLING = {
  active_interval_ms: positiveNumber(julesPolling.active_interval_ms, 5_000),
  idle_interval_ms: positiveNumber(julesPolling.idle_interval_ms, 60_000),
  idle_timeout_ms: positiveNumber(julesPolling.idle_timeout_ms, 60 * 60 * 1_000),
  max_concurrency: Math.max(1, Math.floor(positiveNumber(julesPolling.max_concurrency, 3))),
  min_request_spacing_ms: positiveNumber(julesPolling.min_request_spacing_ms, 250),
  rate_limit_base_delay_ms: positiveNumber(julesPolling.rate_limit_base_delay_ms, 30_000),
  rate_limit_max_delay_ms: positiveNumber(julesPolling.rate_limit_max_delay_ms, 5 * 60 * 1_000),
}

const preWarmed = yamlConfig.pre_warmed_sessions || {}
export const PRE_WARMED_SESSIONS = {
  enabled: typeof preWarmed.enabled === 'boolean' ? preWarmed.enabled : false,
  pool_size: typeof preWarmed.pool_size === 'number' ? preWarmed.pool_size : 1,
  pre_warming_prompt:
    typeof preWarmed.pre_warming_prompt === 'string' ? preWarmed.pre_warming_prompt : '',
}

export const INTERACTIVE_SELECTION =
  typeof yamlConfig.interactive_selection === 'boolean' ? yamlConfig.interactive_selection : false
