import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { parse } from 'yaml'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@prisma/client'

// Load default and user configuration
const examplePath = path.resolve('templates/config.example.yaml')
const userPath = path.resolve('config.yaml')


let yamlConfig: any = {}

try {
  let defaultYaml: any = {}
  if (fs.existsSync(examplePath)) {
    const defaultContent = fs.readFileSync(examplePath, 'utf8')
    defaultYaml = parse(defaultContent) || {}
  }

  let userYaml: any = {}
  if (fs.existsSync(userPath)) {
    const userContent = fs.readFileSync(userPath, 'utf8')
    userYaml = parse(userContent) || {}
  }

  yamlConfig = {
    ...defaultYaml,
    ...userYaml,
    access_control: {
      ...(defaultYaml.access_control || {}),
      ...(userYaml.access_control || {}),
    },
    reactions: {
      ...(defaultYaml.reactions || {}),
      ...(userYaml.reactions || {}),
    },
    guilds: {
      ...(defaultYaml.guilds || {}),
      ...(userYaml.guilds || {}),
    },
    auto_reject: {
      ...(defaultYaml.auto_reject || {}),
      ...(userYaml.auto_reject || {}),
    },
    pre_warmed_sessions: {
      ...(defaultYaml.pre_warmed_sessions || {}),
      ...(userYaml.pre_warmed_sessions || {}),
    },
  }
} catch (err) {
  console.error('Failed to parse config files, using empty defaults:', err)
}



// Diagnostic Prompt for Google Jules
export const DIAGNOSTIC_PROMPT = yamlConfig.diagnostic_prompt || 
`You are a diagnostic help agent talking to a non-technical user. Explain bugs and issues in simple, everyday terms. Avoid developer jargon, deep technical code details, and raw code blocks unless explicitly requested. Use clear analogies to explain what is wrong. Do NOT modify the codebase, write code changes, or create pull requests unless a program-level bug is identified and the user explicitly asks for a code fix. Keep conversation interactive, clear, and friendly.`

// Access Control config
const accessControl = yamlConfig.access_control || {}
export const ALLOW_ALL = typeof accessControl.allow_all === 'boolean'
  ? accessControl.allow_all
  : process.env.ALLOW_ALL !== 'false'

export const ALLOWED_USERS: string[] = Array.isArray(accessControl.allowed_users)
  ? accessControl.allowed_users.map(String)
  : (process.env.ALLOWED_USERS || '').split(',').map((s: string) => s.trim()).filter(Boolean)

export const ALLOWED_ROLES: string[] = Array.isArray(accessControl.allowed_roles)
  ? accessControl.allowed_roles.map(String)
  : (process.env.ALLOWED_ROLES || '').split(',').map((s: string) => s.trim()).filter(Boolean)

// Reactions mapping config
const defaultReactions = {
  queued: "⏳",
  in_progress: "⚙️",
  awaiting_plan_approval: "📋",
  completed: "✅",
  failed: "❌"
}

export const REACTIONS: Record<string, string> = {
  ...defaultReactions,
  ...(yamlConfig.reactions || {})
}

// Guild override mappings from YAML
export const YAML_GUILDS: Record<string, { default_repo?: string; forum_channel_id?: string }> = yamlConfig.guilds || {}

// API Keys and Tokens
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || ''
export const JULES_API_KEY = process.env.JULES_API_KEY || ''
export const DATABASE_URL = process.env.DATABASE_URL || 'file:./prisma/dev.db'

// SQLite Prisma adapter init
const adapter = new PrismaBetterSqlite3({ url: DATABASE_URL })
export const prisma = new PrismaClient({ adapter })

// Auto-reject configuration
const autoReject = yamlConfig.auto_reject || {}
export const AUTO_REJECT = {
  enabled: typeof autoReject.enabled === 'boolean' ? autoReject.enabled : false,
  message: typeof autoReject.message === 'string' ? autoReject.message : ''
}

// Load Agent Personality Markdown
const agentsExamplePath = path.resolve('templates/AGENTS.example.md')
const agentsUserPath = path.resolve('AGENTS.md')
let agentsContent = ''

try {
  if (fs.existsSync(agentsUserPath)) {
    agentsContent = fs.readFileSync(agentsUserPath, 'utf8')
  } else if (fs.existsSync(agentsExamplePath)) {
    agentsContent = fs.readFileSync(agentsExamplePath, 'utf8')
  }
} catch (err) {
  console.error('Failed to load agent personality file:', err)
}

export const AGENT_PERSONALITY = agentsContent

// Load Agent Soul Markdown
const soulExamplePath = path.resolve('templates/SOUL.example.md')
const soulUserPath = path.resolve('SOUL.md')
let soulContent = ''

try {
  if (fs.existsSync(soulUserPath)) {
    soulContent = fs.readFileSync(soulUserPath, 'utf8')
  } else if (fs.existsSync(soulExamplePath)) {
    soulContent = fs.readFileSync(soulExamplePath, 'utf8')
  }
} catch (err) {
  console.error('Failed to load agent soul file:', err)
}

export const SOUL_PERSONALITY = soulContent

// Pre-warmed session config
const preWarmed = yamlConfig.pre_warmed_sessions || {}
export const PRE_WARMED_SESSIONS = {
  enabled: typeof preWarmed.enabled === 'boolean' ? preWarmed.enabled : false,
  pool_size: typeof preWarmed.pool_size === 'number' ? preWarmed.pool_size : 1
}




