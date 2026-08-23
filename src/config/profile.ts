import { logger } from '../lib/utils/logger.js'
import 'dotenv/config'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

// Detect active profile from command line (--profile <name>) or BOT_PROFILE environment variable
let profileName: string | undefined = process.env.BOT_PROFILE
const profileArgIndex = process.argv.indexOf('--profile')
if (profileArgIndex !== -1 && profileArgIndex + 1 < process.argv.length) {
  profileName = process.argv[profileArgIndex + 1]
}

export const isProfileActive = !!profileName
export const activeProfileName: string | undefined = profileName
export const profileDir = isProfileActive ? path.resolve('profiles', profileName!) : null

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
    { src: 'templates/SOUL.example.md', dest: 'SOUL.md' },
  ]

  for (const { src, dest } of templatesToCopy) {
    const srcPath = path.resolve(src)
    const destPath = path.join(profileDir, dest)
    if (!fs.existsSync(destPath) && fs.existsSync(srcPath)) {
      try {
        fs.copyFileSync(srcPath, destPath)
        logger.debug(`[Profile] Copied template ${src} to ${destPath}`)
      } catch (err) {
        logger.error(`[Profile] Failed to copy template ${src} to ${destPath}:`, err)
      }
    }
  }

  // Load profile .env file, overriding existing env vars
  const profileEnvPath = path.join(profileDir, '.env')
  if (fs.existsSync(profileEnvPath)) {
    dotenv.config({ path: profileEnvPath, override: true })
  }
}
