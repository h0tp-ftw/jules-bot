import fs from 'fs'
import path from 'path'
import { logger } from '../lib/utils/logger.js'
import { isProfileActive, profileDir } from './profile.js'

// Load Agent Personality Markdown
const agentsExamplePath = path.resolve('templates/AGENTS.example.md')
const agentsUserPath =
  isProfileActive && profileDir ? path.join(profileDir, 'AGENTS.md') : path.resolve('AGENTS.md')
let agentsContent = ''

try {
  if (fs.existsSync(agentsUserPath)) {
    agentsContent = fs.readFileSync(agentsUserPath, 'utf8')
  } else if (fs.existsSync(agentsExamplePath)) {
    agentsContent = fs.readFileSync(agentsExamplePath, 'utf8')
  }
} catch (err) {
  logger.error('Failed to load agent personality file:', err)
}

export const AGENT_PERSONALITY = agentsContent

// Load Agent Soul Markdown
const soulExamplePath = path.resolve('templates/SOUL.example.md')
const soulUserPath =
  isProfileActive && profileDir ? path.join(profileDir, 'SOUL.md') : path.resolve('SOUL.md')
let soulContent = ''

try {
  if (fs.existsSync(soulUserPath)) {
    soulContent = fs.readFileSync(soulUserPath, 'utf8')
  } else if (fs.existsSync(soulExamplePath)) {
    soulContent = fs.readFileSync(soulExamplePath, 'utf8')
  }
} catch (err) {
  logger.error('Failed to load agent soul file:', err)
}

export const SOUL_PERSONALITY = soulContent
