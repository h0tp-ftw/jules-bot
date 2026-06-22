import { logger } from '../utils/logger.js'
import { jules } from '@google/jules-sdk'
import { JULES_API_KEY, getBootstrapContext, getEffectiveConfig } from '../../config.js'

// Shared Jules SDK client. Exported so PreWarmedManager reuses this single
// instance instead of constructing a second one.
export const julesApiClient = JULES_API_KEY
  ? jules.with({ apiKey: JULES_API_KEY, config: { requestTimeoutMs: 180000 } })
  : jules.with({ config: { requestTimeoutMs: 180000 } })
const client = julesApiClient

export interface CreateSessionOptions {
  prompt: string
  repo: string
  branch?: string
  title?: string
  thread?: any // Optional thread/channel context
  member?: any // Optional member context
}

export class JulesClient {
  static async createSession(options: CreateSessionOptions) {
    const threadConfig = getEffectiveConfig(options.thread, options.member)

    let sessionPrompt = `${threadConfig.diagnostic_prompt}\n\nAgent Personality and Guidelines:\n${threadConfig.agents_personality}\n\nAgent Soul and Principles:\n${threadConfig.soul_personality}`
    const bootstrapContext = getBootstrapContext()
    if (bootstrapContext) {
      sessionPrompt += `\n\nBootstrap Knowledge and Context:\n${bootstrapContext}`
    }
    if (threadConfig.jules_reactions?.enabled) {
      sessionPrompt += `\n\n${threadConfig.messages.prompts.jules_reactions_instruction}`
    }
    sessionPrompt += `\n\nUser Issue:\n${options.prompt}`

    return await client.session({
      prompt: sessionPrompt,
      source: { github: options.repo, baseBranch: options.branch || 'main' },
      title: options.title || threadConfig.messages.session.default_title,
      requireApproval: true,
    })
  }

  static getSession(sessionId: string) {
    return client.session(sessionId)
  }

  // A single interactive repo/branch-selection flow calls getConnectedRepos()
  // several times (pick repo -> list branches -> search/clear), each a full
  // network walk of client.sources(). Cache the result briefly to dedupe those
  // back-to-back calls. Short TTL so a freshly connected repo/branch shows up
  // quickly; the custom-branch input path can always reach any branch directly.
  private static reposCache: { repos: ConnectedRepo[]; expiresAt: number } | null = null
  private static readonly REPOS_CACHE_TTL_MS = 30_000

  static async getConnectedRepos(forceRefresh = false): Promise<ConnectedRepo[]> {
    const now = Date.now()
    if (!forceRefresh && this.reposCache && this.reposCache.expiresAt > now) {
      return this.reposCache.repos
    }

    const repos: ConnectedRepo[] = []
    try {
      for await (const source of client.sources()) {
        if (source.type === 'githubRepo') {
          repos.push({
            name: `${source.githubRepo.owner}/${source.githubRepo.repo}`,
            id: source.id,
            defaultBranch: source.githubRepo.defaultBranch,
            branches: source.githubRepo.branches || [],
          })
        }
      }
      this.reposCache = { repos, expiresAt: now + this.REPOS_CACHE_TTL_MS }
    } catch (err) {
      logger.error('[JulesClient] Failed to list connected sources:', err)
      // Prefer returning a slightly stale list over an empty one when the
      // network call fails mid-flow.
      if (this.reposCache) return this.reposCache.repos
    }
    return repos
  }
}

interface ConnectedRepo {
  name: string
  id: string
  defaultBranch?: string
  branches: string[]
}
