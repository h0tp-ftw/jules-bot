import 'dotenv/config'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@prisma/client'

// Diagnostic Prompt for Google Jules
export const DIAGNOSTIC_PROMPT = 
`You are a diagnostic help agent talking to a non-technical user. Explain bugs and issues in simple, everyday terms. Avoid developer jargon, deep technical code details, and raw code blocks unless explicitly requested. Use clear analogies to explain what is wrong. Do NOT modify the codebase, write code changes, or create pull requests unless a program-level bug is identified and the user explicitly asks for a code fix. Keep conversation interactive, clear, and friendly.`

// API Keys and Tokens
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || ''
export const JULES_API_KEY = process.env.JULES_API_KEY || ''
export const DATABASE_URL = process.env.DATABASE_URL || 'file:./prisma/dev.db'

// Permission Access Control
export const ALLOW_ALL = process.env.ALLOW_ALL !== 'false'
export const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean)
export const ALLOWED_ROLES = (process.env.ALLOWED_ROLES || '').split(',').map((s) => s.trim()).filter(Boolean)

// SQLite Prisma adapter init
const adapter = new PrismaBetterSqlite3({ url: DATABASE_URL })
export const prisma = new PrismaClient({ adapter })
