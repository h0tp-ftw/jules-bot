import fs from 'fs'
import path from 'path'
import { parse } from 'yaml'
import { logger } from '../lib/utils/logger.js'
import { validateUserConfig } from '../lib/utils/configValidation.js'
import { deepMergeMessages } from '../strings.js'
import { isProfileActive, profileDir } from './profile.js'

// Load default and user configuration
const examplePath = path.resolve('templates/config.example.yaml')
const userPath =
  isProfileActive && profileDir ? path.join(profileDir, 'config.yaml') : path.resolve('config.yaml')

export let yamlConfig: any = {}

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
    validateUserConfig(userYaml, userPath)
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
    jules_reactions: {
      ...(defaultYaml.jules_reactions || {}),
      ...(userYaml.jules_reactions || {}),
    },
    nudge: {
      ...(defaultYaml.nudge || {}),
      ...(userYaml.nudge || {}),
    },
    jules_polling: {
      ...(defaultYaml.jules_polling || {}),
      ...(userYaml.jules_polling || {}),
    },
    pre_warmed_sessions: {
      ...(defaultYaml.pre_warmed_sessions || {}),
      ...(userYaml.pre_warmed_sessions || {}),
    },
    roles: {
      ...(defaultYaml.roles || {}),
      ...(userYaml.roles || {}),
    },
    presence: {
      ...(defaultYaml.presence || {}),
      ...(userYaml.presence || {}),
    },
    // Deep-merged so a partial override (just one string) keeps the rest of
    // the example file's overrides intact. Code defaults are layered on later.
    messages: deepMergeMessages({}, defaultYaml.messages || {}, userYaml.messages || {}),
  }
} catch (err) {
  logger.error('Failed to load config files. Refusing to start with silent defaults:', err)
  throw err
}
