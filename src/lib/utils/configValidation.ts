const KNOWN_TOP_LEVEL_KEYS = new Set([
  'diagnostic_prompt',
  'bot_emoji',
  'access_control',
  'reactions',
  'guilds',
  'auto_reject',
  'jules_reactions',
  'interactive_selection',
  'ignore_prefix',
  'presence',
  'pre_warmed_sessions',
  'channels',
  'roles',
  'tags',
  'messages',
  'default_repo',
  'default_branch',
  'typing_indicator_mode',
  'bootstrap',
  'reply_mode',
])

const FOREIGN_CONFIG_KEYS = new Set(['model_list', 'litellm_settings'])

export function validateUserConfig(config: unknown, configPath: string): void {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${configPath} must contain a YAML mapping at the top level.`)
  }

  const keys = Object.keys(config)
  if (keys.length === 0) return

  const foreignKeys = keys.filter((key) => FOREIGN_CONFIG_KEYS.has(key))
  if (foreignKeys.length > 0) {
    throw new Error(
      `${configPath} appears to contain configuration for another application (` +
        `${foreignKeys.join(', ')}). Refusing to start with JulesBot defaults.`,
    )
  }

  if (!keys.some((key) => KNOWN_TOP_LEVEL_KEYS.has(key))) {
    throw new Error(
      `${configPath} does not contain any recognized JulesBot settings. ` +
        `Found top-level keys: ${keys.join(', ')}.`,
    )
  }
}
