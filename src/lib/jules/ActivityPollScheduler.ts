import { JulesRateLimitError } from '@google/jules-sdk'
import { logger } from '../utils/logger.js'

export type ActivityPollMode = 'active' | 'idle'

export type ActivityPollSchedulerConfig = {
  active_interval_ms: number
  idle_interval_ms: number
  idle_timeout_ms: number
  max_concurrency: number
  min_request_spacing_ms: number
  rate_limit_base_delay_ms: number
  rate_limit_max_delay_ms: number
}

type StreamState = {
  mode: ActivityPollMode
  idleSince: number | null
  nextPollAt: number
}

type Waiter = {
  timer: NodeJS.Timeout
  resolve: () => void
}

export type ScheduledPollResult<T> =
  | { expired: true }
  | {
      expired: false
      value: T
    }

export function isJulesRateLimitError(error: unknown): boolean {
  if (error instanceof JulesRateLimitError) return true
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; message?: unknown; name?: unknown }
  return (
    candidate.status === 429 ||
    candidate.name === 'JulesRateLimitError' ||
    (typeof candidate.message === 'string' &&
      /429|too many requests|rate limit/i.test(candidate.message))
  )
}

/**
 * Central coordinator for all Jules activity polling.
 *
 * Individual stream handlers still own Discord/session state, but every network
 * sync is scheduled through this coordinator. That gives the process one shared
 * concurrency ceiling and one shared rate-limit cooldown instead of N unrelated
 * timers/retry loops stampeding the Jules API together.
 */
export class ActivityPollScheduler {
  private readonly states = new Map<string, StreamState>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly permitWaiters: Array<() => void> = []
  private inFlight = 0
  private nextRequestAt = 0
  private globalRateLimitUntil = 0
  private rateLimitLevel = 0

  constructor(
    private readonly config: ActivityPollSchedulerConfig,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  register(key: string): void {
    if (this.states.has(key)) return
    this.states.set(key, {
      mode: 'active',
      idleSince: null,
      nextPollAt: this.now(),
    })
  }

  remove(key: string): void {
    this.states.delete(key)
    this.resolveWaiter(key)
  }

  has(key: string): boolean {
    return this.states.has(key)
  }

  markIdle(key: string, refresh = true): void {
    const state = this.states.get(key)
    if (!state) return
    if (refresh || state.mode !== 'idle' || state.idleSince === null) {
      state.idleSince = this.now()
    }
    state.mode = 'idle'
  }

  markActive(key: string): void {
    const state = this.states.get(key)
    if (!state) return
    state.mode = 'active'
    state.idleSince = null
  }

  /** Wake a dormant watcher immediately after an external Discord action. */
  wake(key: string): void {
    const state = this.states.get(key)
    if (!state) return
    state.mode = 'active'
    state.idleSince = null
    state.nextPollAt = this.now()
    this.resolveWaiter(key)
  }

  getMode(key: string): ActivityPollMode | undefined {
    return this.states.get(key)?.mode
  }

  getIdleSince(key: string): number | null | undefined {
    return this.states.get(key)?.idleSince
  }

  getGlobalRateLimitUntil(): number {
    return this.globalRateLimitUntil
  }

  async request<T>(operation: () => Promise<T>): Promise<T> {
    while (true) {
      const requestDueAt = Math.max(this.globalRateLimitUntil, this.nextRequestAt)
      if (requestDueAt > this.now()) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, requestDueAt - this.now())),
        )
      }

      await this.acquirePermit()
      try {
        // Another request may have extended the global cooldown while this one
        // was queued for a concurrency permit. Re-check before touching Jules.
        if (Math.max(this.globalRateLimitUntil, this.nextRequestAt) > this.now()) continue
        this.nextRequestAt = this.now() + this.config.min_request_spacing_ms
        try {
          const value = await operation()
          this.rateLimitLevel = 0
          return value
        } catch (error) {
          if (isJulesRateLimitError(error)) {
            this.applyGlobalRateLimit()
            continue
          }
          throw error
        }
      } finally {
        this.releasePermit()
      }
    }
  }

  async poll<T>(key: string, operation: () => Promise<T>): Promise<ScheduledPollResult<T>> {
    const state = this.states.get(key)
    if (!state) return { expired: true }

    while (true) {
      const current = this.states.get(key)
      if (!current) return { expired: true }

      const now = this.now()
      if (
        current.mode === 'idle' &&
        current.idleSince !== null &&
        now - current.idleSince >= this.config.idle_timeout_ms
      ) {
        return { expired: true }
      }

      const idleExpiry =
        current.mode === 'idle' && current.idleSince !== null
          ? current.idleSince + this.config.idle_timeout_ms
          : Number.POSITIVE_INFINITY
      const dueAt = Math.max(current.nextPollAt, this.globalRateLimitUntil, this.nextRequestAt)
      const wakeAt = Math.min(dueAt, idleExpiry)

      if (wakeAt > now) {
        await this.wait(key, wakeAt - now)
        continue
      }

      if (idleExpiry <= now) return { expired: true }

      await this.acquirePermit()
      try {
        const rechecked = this.states.get(key)
        if (!rechecked) return { expired: true }
        if (Math.max(this.globalRateLimitUntil, this.nextRequestAt) > this.now()) continue
        this.nextRequestAt = this.now() + this.config.min_request_spacing_ms

        try {
          const value = await operation()
          this.rateLimitLevel = 0
          const after = this.states.get(key)
          if (after) {
            const interval =
              after.mode === 'idle' ? this.config.idle_interval_ms : this.config.active_interval_ms
            after.nextPollAt = this.now() + interval
          }
          return { expired: false, value }
        } catch (error) {
          if (isJulesRateLimitError(error)) {
            this.applyGlobalRateLimit()
            const after = this.states.get(key)
            if (after) after.nextPollAt = this.globalRateLimitUntil
            continue
          }
          throw error
        }
      } finally {
        this.releasePermit()
      }
    }
  }

  private applyGlobalRateLimit(): void {
    const exponential = Math.min(
      this.config.rate_limit_base_delay_ms * 2 ** this.rateLimitLevel,
      this.config.rate_limit_max_delay_ms,
    )
    // 0–20% jitter keeps multiple processes/hosts from resuming on the same edge.
    const jitter = Math.floor(exponential * 0.2 * this.random())
    this.globalRateLimitUntil = Math.max(
      this.globalRateLimitUntil,
      this.now() + exponential + jitter,
    )
    this.rateLimitLevel = Math.min(this.rateLimitLevel + 1, 16)
    const remainingMs = Math.max(0, this.globalRateLimitUntil - this.now())
    logger.warn(
      `[JulesPollScheduler] Jules API rate limit hit; pausing all scheduled Jules requests for about ${Math.ceil(remainingMs / 1000)}s.`,
    )
    for (const key of [...this.waiters.keys()]) this.resolveWaiter(key)
  }

  private async acquirePermit(): Promise<void> {
    if (this.inFlight < this.config.max_concurrency) {
      this.inFlight++
      return
    }
    await new Promise<void>((resolve) => this.permitWaiters.push(resolve))
    this.inFlight++
  }

  private releasePermit(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    const next = this.permitWaiters.shift()
    next?.()
  }

  private wait(key: string, ms: number): Promise<void> {
    this.resolveWaiter(key)
    return new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          this.waiters.delete(key)
          resolve()
        },
        Math.max(1, ms),
      )
      this.waiters.set(key, { timer, resolve })
    })
  }

  private resolveWaiter(key: string): void {
    const waiter = this.waiters.get(key)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.waiters.delete(key)
    waiter.resolve()
  }
}
