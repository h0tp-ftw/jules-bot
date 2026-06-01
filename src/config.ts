import 'dotenv/config'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { parse } from 'yaml'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@prisma/client'
import { execSync } from 'child_process'

// Detect active profile from command line (--profile <name>) or BOT_PROFILE environment variable
let profileName: string | undefined = process.env.BOT_PROFILE
const profileArgIndex = process.argv.indexOf('--profile')
if (profileArgIndex !== -1 && profileArgIndex + 1 < process.argv.length) {
  profileName = process.argv[profileArgIndex + 1]
}

const isProfileActive = !!profileName
const profileDir = isProfileActive ? path.resolve('profiles', profileName!) : null

if (isProfileActive && profileDir) {
  // Ensure profile directory exists
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true })
  }

  // Ensure bootstrap directory inside profile exists
  const profileBootstrapDir = path.join(profileDir, 'bootstrap')
  if (!fs.existsSync(profileBootstrapDir)) {
    fs.mkdirSync(profileBootstrapDir, { recursive: true })
  }

  // Copy template files if they are missing
  const templatesToCopy = [
    { src: 'templates/.env.example', dest: '.env' },
    { src: 'templates/config.example.yaml', dest: 'config.yaml' },
    { src: 'templates/AGENTS.example.md', dest: 'AGENTS.md' },
    { src: 'templates/SOUL.example.md', dest: 'SOUL.md' }
  ]

  for (const { src, dest } of templatesToCopy) {
    const srcPath = path.resolve(src)
    const destPath = path.join(profileDir, dest)
    if (!fs.existsSync(destPath) && fs.existsSync(srcPath)) {
      try {
        fs.copyFileSync(srcPath, destPath)
        console.log(`[Profile] Copied template ${src} to ${destPath}`)
      } catch (err) {
        console.error(`[Profile] Failed to copy template ${src} to ${destPath}:`, err)
      }
    }
  }

  // Load profile .env file, overriding existing env vars
  const profileEnvPath = path.join(profileDir, '.env')
  if (fs.existsSync(profileEnvPath)) {
    dotenv.config({ path: profileEnvPath, override: true })
  }
}

// Load default and user configuration
const examplePath = path.resolve('templates/config.example.yaml')
const userPath = isProfileActive && profileDir
  ? path.join(profileDir, 'config.yaml')
  : path.resolve('config.yaml')


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
  responded: "💬",
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

let rawDatabaseUrl = process.env.DATABASE_URL
if (!rawDatabaseUrl) {
  rawDatabaseUrl = isProfileActive && profileDir
    ? `file:profiles/${profileName}/dev.db`
    : 'file:./prisma/dev.db'
} else if (isProfileActive && profileDir && rawDatabaseUrl.startsWith('file:')) {
  const rawPath = rawDatabaseUrl.slice(5)
  if (!path.isAbsolute(rawPath)) {
    const resolvedPath = path.resolve(profileDir, rawPath).replace(/\\/g, '/')
    rawDatabaseUrl = `file:${resolvedPath}`
  }
}

export const DATABASE_URL = rawDatabaseUrl
// Ensure process.env has the resolved DATABASE_URL for Prisma config and CLI usage
process.env.DATABASE_URL = DATABASE_URL

if (DATABASE_URL.startsWith('file:')) {
  const dbPath = path.resolve(DATABASE_URL.slice(5))
  if (!fs.existsSync(dbPath)) {
    console.log(`[Database] SQLite file not found at ${dbPath}. Auto-provisioning...`)
    const dbDir = path.dirname(dbPath)
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
    try {
      console.log(`[Database] Running 'npx prisma db push' to provision database...`)
      execSync('npx prisma db push', {
        env: { ...process.env, DATABASE_URL: DATABASE_URL },
        stdio: 'inherit'
      })
      console.log(`[Database] Successfully provisioned SQLite database at ${dbPath}`)
    } catch (err) {
      console.error('[Database] Failed to auto-provision SQLite database:', err)
    }
  }
}

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
const agentsUserPath = isProfileActive && profileDir
  ? path.join(profileDir, 'AGENTS.md')
  : path.resolve('AGENTS.md')
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
const soulUserPath = isProfileActive && profileDir
  ? path.join(profileDir, 'SOUL.md')
  : path.resolve('SOUL.md')
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

const preWarmed = yamlConfig.pre_warmed_sessions || {}
export const PRE_WARMED_SESSIONS = {
  enabled: typeof preWarmed.enabled === 'boolean' ? preWarmed.enabled : false,
  pool_size: typeof preWarmed.pool_size === 'number' ? preWarmed.pool_size : 1,
  pre_warming_prompt: typeof preWarmed.pre_warming_prompt === 'string' ? preWarmed.pre_warming_prompt : ''
}

// Helper to recursively read all files in a directory
function getFilesRecursively(dir: string, baseDir: string = dir): { relativePath: string; content: string }[] {
  let results: { relativePath: string; content: string }[] = []
  if (!fs.existsSync(dir)) return results

  const list = fs.readdirSync(dir)
  for (const file of list) {
    const filePath = path.join(dir, file)
    const stat = fs.statSync(filePath)
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(filePath, baseDir))
    } else if (stat && stat.isFile()) {
      const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/')
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        results.push({ relativePath, content })
      } catch (err) {
        console.error(`Failed to read file ${filePath}:`, err)
      }
    }
  }
  return results
}

// Dynamically construct bootstrap context from all files in bootstrap/
export function getBootstrapContext(): string {
  let bootstrapDir = path.resolve('bootstrap')
  if (isProfileActive && profileDir) {
    const profileBootstrapDir = path.join(profileDir, 'bootstrap')
    if (fs.existsSync(profileBootstrapDir) && fs.readdirSync(profileBootstrapDir).length > 0) {
      bootstrapDir = profileBootstrapDir
    }
  }
  if (!fs.existsSync(bootstrapDir)) {
    return ''
  }
  try {
    const files = getFilesRecursively(bootstrapDir)
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

    const blocks = []
    for (const file of files) {
      blocks.push(`### FILE: bootstrap/${file.relativePath}\n\n${file.content}`)
    }
    return blocks.join('\n\n')
  } catch (err) {
    console.error('Failed to build bootstrap context:', err)
    return ''
  }
}

// Log initial bootstrap status on startup
try {
  let bootstrapDir = path.resolve('bootstrap')
  if (isProfileActive && profileDir) {
    const profileBootstrapDir = path.join(profileDir, 'bootstrap')
    if (fs.existsSync(profileBootstrapDir) && fs.readdirSync(profileBootstrapDir).length > 0) {
      bootstrapDir = profileBootstrapDir
    }
  }
  if (fs.existsSync(bootstrapDir)) {
    const files = getFilesRecursively(bootstrapDir)
    const totalSize = files.reduce((acc, f) => acc + f.content.length, 0)
    console.log(`[Bootstrap] Initialized with ${files.length} bootstrap files. Total size: ${totalSize} chars.`)
  }
} catch (err) {
  console.error('Failed to log bootstrap status on startup:', err)
}





