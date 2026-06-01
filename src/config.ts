import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { parse } from 'yaml'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@prisma/client'

// Load config.yaml
const configPath = path.resolve('config.yaml')
let yamlConfig: any = {}

try {
  if (fs.existsSync(configPath)) {
    const fileContent = fs.readFileSync(configPath, 'utf8')
    yamlConfig = parse(fileContent) || {}
  }
} catch (err) {
  console.error('Failed to parse config.yaml, using defaults:', err)
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
