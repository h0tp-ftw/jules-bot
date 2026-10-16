import { logger } from '../utils/logger.js'
import {
  connect,
  MemoryStorage,
  MemorySessionStorage,
  type StorageFactory,
} from '@google/jules-sdk'
import { JULES_API_KEY, getBootstrapContext, getEffectiveConfig } from '../../config.js'
import { scheduleJulesRequest } from './JulesRequestCoordinator.js'
import type { JulesSession } from './julesTypes.js'

// Bounded in-memory storage implementations so activities and session metadata stay in memory
// without growing unbounded across hundreds of sessions and days of continuous uptime.
const MAX_ACTIVITIES_PER_SESSION = 200
const MAX_SESSIONS_IN_MEMORY = 50

export class BoundedMemoryStorage {
  private activities: any[] = []
  private indices = new Map<string, number>()

  async init(): Promise<void> {}

  async close(): Promise<void> {
    this.activities = []
    this.indices.clear()
  }

  async append(activity: any): Promise<void> {
    if (this.indices.has(activity.id)) {
      const index = this.indices.get(activity.id)!
      this.activities[index] = activity
    } else {
      const index = this.activities.push(activity) - 1
      this.indices.set(activity.id, index)

      // Prune oldest activities when exceeding the limit
      if (this.activities.length > MAX_ACTIVITIES_PER_SESSION) {
        const excess = this.activities.length - MAX_ACTIVITIES_PER_SESSION
        this.activities.splice(0, excess)
        this.indices.clear()
        for (let i = 0; i < this.activities.length; i++) {
          this.indices.set(this.activities[i].id, i)
        }
      }
    }
  }

  async get(activityId: string): Promise<any | undefined> {
    const index = this.indices.get(activityId)
    return index !== undefined ? this.activities[index] : undefined
  }

  async latest(): Promise<any | undefined> {
    return this.activities.length === 0 ? undefined : this.activities[this.activities.length - 1]
  }

  async *scan(): AsyncGenerator<any, void, unknown> {
    for (const activity of this.activities) {
      yield activity
    }
  }
}

export class BoundedSessionStorage {
  private sessions = new Map<string, { resource: any; _lastSyncedAt: number }>()
  private index: any[] = []

  async init(): Promise<void> {}

  async upsert(session: any): Promise<void> {
    // Delete first to preserve LRU insertion order
    if (this.sessions.has(session.id)) {
      this.sessions.delete(session.id)
    } else if (this.sessions.size >= MAX_SESSIONS_IN_MEMORY) {
      // Evict oldest session
      const oldestKey = this.sessions.keys().next().value
      if (oldestKey) {
        this.sessions.delete(oldestKey)
      }
    }

    this.sessions.set(session.id, {
      resource: session,
      _lastSyncedAt: Date.now(),
    })

    this.index.push({
      id: session.id,
      title: session.title,
      state: session.state,
      createTime: session.createTime,
      source: session.sourceContext?.source || 'unknown',
      _updatedAt: Date.now(),
    })

    if (this.index.length > MAX_SESSIONS_IN_MEMORY * 2) {
      this.index.splice(0, this.index.length - MAX_SESSIONS_IN_MEMORY)
    }
  }

  async upsertMany(sessions: any[]): Promise<void> {
    for (const s of sessions) {
      await this.upsert(s)
    }
  }

  async get(sessionId: string): Promise<any | undefined> {
    return this.sessions.get(sessionId)
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
    this.index = this.index.filter((e) => e.id !== sessionId)
  }

  async *scanIndex(): AsyncGenerator<any, void, unknown> {
    for (const entry of this.index) {
      yield entry
    }
  }
}

const activeActivityStorages = new Map<string, BoundedMemoryStorage>()
export const defaultSessionStorage = new BoundedSessionStorage()

export function evictSessionStorage(sessionId: string): void {
  const activityStorage = activeActivityStorages.get(sessionId)
  if (activityStorage) {
    activityStorage.close().catch(() => {})
    activeActivityStorages.delete(sessionId)
  }
  defaultSessionStorage.delete(sessionId).catch(() => {})
}

// Shared in-memory storage factory with bounds and eviction capability
export const memoryStorageFactory: StorageFactory = {
  activity: (sessionId?: string) => {
    if (sessionId) {
      let storage = activeActivityStorages.get(sessionId)
      if (!storage) {
        // Enforce max active activity storages
        if (activeActivityStorages.size >= MAX_SESSIONS_IN_MEMORY) {
          const oldestSessionId = activeActivityStorages.keys().next().value
          if (oldestSessionId) {
            const oldStorage = activeActivityStorages.get(oldestSessionId)
            oldStorage?.close().catch(() => {})
            activeActivityStorages.delete(oldestSessionId)
          }
        }
        storage = new BoundedMemoryStorage()
        activeActivityStorages.set(sessionId, storage)
      }
      return storage as any
    }
    return new BoundedMemoryStorage() as any
  },
  session: () => defaultSessionStorage as any,
}

// Shared Jules SDK client. Exported so PreWarmedManager reuses this single
// instance instead of constructing a second one.
export const julesApiClient = connect({
  apiKey: JULES_API_KEY || undefined,
  storageFactory: memoryStorageFactory,
  config: { requestTimeoutMs: 180000 },
})
const client = julesApiClient

export interface CreateSessionOptions {
  prompt: string
  repo?: string
  branch?: string
  title?: string
  thread?: any // Optional thread/channel context
  member?: any // Optional member context
  omitPersonas?: boolean
}

export class JulesClient {
  static async createSession(options: CreateSessionOptions) {
    const threadConfig = getEffectiveConfig(options.thread, options.member)

    let sessionPrompt = threadConfig.diagnostic_prompt
    if (!options.omitPersonas) {
      sessionPrompt += `\n\nAgent Personality and Guidelines:\n${threadConfig.agents_personality}\n\nAgent Soul and Principles:\n${threadConfig.soul_personality}`
    }
    if (threadConfig.bootstrap !== false) {
      const bootstrapContext = getBootstrapContext()
      if (bootstrapContext) {
        sessionPrompt += `\n\nBootstrap Knowledge and Context:\n${bootstrapContext}`
      }
    }
    sessionPrompt += `\n\n${threadConfig.messages.prompts.delivery_status_instruction}`
    if (threadConfig.jules_reactions?.enabled) {
      sessionPrompt += `\n\n${threadConfig.messages.prompts.jules_reactions_instruction}`
    }
    sessionPrompt += `\n\nUser Issue:\n${options.prompt}`

    const isRepoless = !options.repo || options.repo === 'NO_CODEBASE'
    const sessionConfig: any = {
      prompt: sessionPrompt,
      title: options.title || threadConfig.messages.session.default_title,
      requireApproval: true,
    }

    if (!isRepoless && options.repo) {
      sessionConfig.source = { github: options.repo, baseBranch: options.branch || 'main' }
    }

    return await client.session(sessionConfig)
  }

  static getSession(sessionId: string): JulesSession {
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

    let repos: ConnectedRepo[] = []
    try {
      repos = await scheduleJulesRequest(async () => {
        const listed: ConnectedRepo[] = []
        for await (const source of client.sources()) {
          if (source.type === 'githubRepo') {
            listed.push({
              name: `${source.githubRepo.owner}/${source.githubRepo.repo}`,
              id: source.id,
              defaultBranch: source.githubRepo.defaultBranch,
              branches: source.githubRepo.branches || [],
            })
          }
        }
        return listed
      })
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
