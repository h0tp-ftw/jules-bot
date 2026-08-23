import fs from 'fs'
import path from 'path'
import { logger } from '../lib/utils/logger.js'
import { isProfileActive, profileDir } from './profile.js'

// Helper to recursively read all files in a directory
function getFilesRecursively(
  dir: string,
  baseDir: string = dir,
): { relativePath: string; content: string }[] {
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
        logger.error(`Failed to read file ${filePath}:`, err)
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
    logger.error('Failed to build bootstrap context:', err)
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
    logger.info(
      `[Bootstrap] Initialized with ${files.length} bootstrap files. Total size: ${totalSize} chars.`,
    )
  }
} catch (err) {
  logger.error('Failed to log bootstrap status on startup:', err)
}
