import { jules } from '@google/jules-sdk'
import { JULES_API_KEY, getBootstrapContext, getEffectiveConfig } from '../../config.js'

const client = JULES_API_KEY ? jules.with({ apiKey: JULES_API_KEY }) : jules

export interface CreateSessionOptions {
  prompt: string
  repo: string
  branch?: string
  title?: string
  thread?: any // Optional thread/channel context
}

export class JulesClient {
  static async createSession(options: CreateSessionOptions) {
    const threadConfig = getEffectiveConfig(options.thread)

    let sessionPrompt = `${threadConfig.diagnostic_prompt}\n\nAgent Personality and Guidelines:\n${threadConfig.agents_personality}\n\nAgent Soul and Principles:\n${threadConfig.soul_personality}`
    const bootstrapContext = getBootstrapContext()
    if (bootstrapContext) {
      sessionPrompt += `\n\nBootstrap Knowledge and Context:\n${bootstrapContext}`
    }
    sessionPrompt += `\n\nUser Issue:\n${options.prompt}`

    return await client.session({
      prompt: sessionPrompt,
      source: { github: options.repo, baseBranch: options.branch || 'main' },
      title: options.title || 'Diagnostic Session',
      requireApproval: true,
    })
  }

  static getSession(sessionId: string) {
    return client.session(sessionId)
  }
}
