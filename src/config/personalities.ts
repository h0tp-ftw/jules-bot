import fs from 'fs'
import path from 'path'
import { logger } from '../lib/utils/logger.js'
import { isProfileActive, profileDir } from './profile.js'

function resolvePersonalityFile(filename: string, exampleFilename: string): string {
  const examplePath = path.resolve('templates', exampleFilename)
  const candidatePaths: string[] = []

  if (isProfileActive && profileDir) {
    candidatePaths.push(path.join(profileDir, 'prompts', filename))
    candidatePaths.push(path.join(profileDir, filename))
  }
  candidatePaths.push(path.resolve('prompts', filename))
  candidatePaths.push(path.resolve(filename))

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      try {
        return fs.readFileSync(candidate, 'utf8')
      } catch (err) {
        logger.error(`Failed to read personality file at ${candidate}:`, err)
      }
    }
  }

  if (fs.existsSync(examplePath)) {
    try {
      return fs.readFileSync(examplePath, 'utf8')
    } catch (err) {
      logger.error(`Failed to read example personality file at ${examplePath}:`, err)
    }
  }

  return ''
}

export const AGENT_PERSONALITY = resolvePersonalityFile('AGENTS.md', 'AGENTS.example.md')
export const SOUL_PERSONALITY = resolvePersonalityFile('SOUL.md', 'SOUL.example.md')
