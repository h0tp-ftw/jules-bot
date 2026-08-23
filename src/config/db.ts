import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@prisma/client'
import { logger } from '../lib/utils/logger.js'
import { isProfileActive, activeProfileName, profileDir } from './profile.js'

let rawDatabaseUrl = process.env.DATABASE_URL
if (!rawDatabaseUrl) {
  rawDatabaseUrl =
    isProfileActive && profileDir
      ? `file:profiles/${activeProfileName}/dev.db`
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
    logger.info(`[Database] SQLite file not found at ${dbPath}. Auto-provisioning...`)
    const dbDir = path.dirname(dbPath)
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
    // Prefer applying the committed migrations (records them in
    // _prisma_migrations, so a later `prisma migrate deploy` stays consistent);
    // fall back to a schema push if migrate deploy is unavailable. `prisma` is a
    // runtime dependency so this works under `npm ci --omit=dev` too.
    try {
      logger.debug(`[Database] Provisioning via 'npx prisma migrate deploy'...`)
      execSync('npx prisma migrate deploy', {
        env: { ...process.env, DATABASE_URL: DATABASE_URL },
        stdio: 'inherit',
      })
      logger.info(`[Database] Provisioned SQLite database at ${dbPath} (migrations applied).`)
    } catch (migrateErr) {
      logger.warn('[Database] migrate deploy failed; falling back to db push:', migrateErr)
      try {
        execSync('npx prisma db push', {
          env: { ...process.env, DATABASE_URL: DATABASE_URL },
          stdio: 'inherit',
        })
        logger.info(`[Database] Provisioned SQLite database at ${dbPath} (db push).`)
      } catch (pushErr) {
        logger.error('[Database] Failed to auto-provision SQLite database:', pushErr)
      }
    }
  }
}

// SQLite Prisma adapter init
const adapter = new PrismaBetterSqlite3({ url: DATABASE_URL })
export const prisma = new PrismaClient({ adapter })
