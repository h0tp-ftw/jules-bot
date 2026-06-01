import { jules } from '@google/jules-sdk'
import { JULES_API_KEY, DIAGNOSTIC_PROMPT, AGENT_PERSONALITY, SOUL_PERSONALITY } from '../../config.js'

const client = JULES_API_KEY ? jules.with({ apiKey: JULES_API_KEY }) : jules

export interface CreateSessionOptions {
  prompt: string
  repo: string
  branch?: string
  title?: string
}

export class JulesClient {
  static async createSession(options: CreateSessionOptions) {
    const sessionPrompt = `${DIAGNOSTIC_PROMPT}\n\nAgent Personality and Guidelines:\n${AGENT_PERSONALITY}\n\nAgent Soul and Principles:\n${SOUL_PERSONALITY}\n\nUser Issue:\n${options.prompt}`
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
