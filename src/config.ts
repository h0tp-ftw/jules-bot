// Barrel: preserves the historical `src/config.js` import path. Implementation
// lives in src/config/* — see each module for its responsibility:
//   profile.ts        profile detection, template bootstrap, .env overlay
//   yaml.ts           example+user YAML loading and section merges
//   constants.ts      static config values derived from YAML/env
//   db.ts             DATABASE_URL resolution, SQLite provisioning, prisma client
//   personalities.ts  AGENTS.md / SOUL.md markdown loaders
//   bootstrap.ts      bootstrap/ directory context builder
//   effectiveConfig.ts per-thread/channel/role/tag config resolution
export { isProfileActive, activeProfileName, profileDir } from './config/profile.js'
export { yamlConfig } from './config/yaml.js'
export {
  MESSAGES,
  DIAGNOSTIC_PROMPT,
  BOT_EMOJI,
  ALLOW_ALL,
  ALLOWED_USERS,
  ALLOWED_ROLES,
  ALLOW_SILENT,
  DEFAULT_REACTIONS,
  REACTIONS,
  YAML_GUILDS,
  DISCORD_TOKEN,
  JULES_API_KEY,
  AUTO_REJECT,
  JULES_REACTIONS,
  NUDGE,
  JULES_POLLING,
  PRE_WARMED_SESSIONS,
  INTERACTIVE_SELECTION,
} from './config/constants.js'
export { DATABASE_URL, prisma } from './config/db.js'
export { AGENT_PERSONALITY, SOUL_PERSONALITY } from './config/personalities.js'
export { getBootstrapContext } from './config/bootstrap.js'
export { getEffectiveConfig, normalizeReplyContextMode } from './config/effectiveConfig.js'
export type { ReplyContextMode } from './config/effectiveConfig.js'
