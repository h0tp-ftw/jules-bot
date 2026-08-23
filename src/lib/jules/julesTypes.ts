import type { Outcome, SessionState } from '@google/jules-sdk'

// Typed contract for the Jules SDK boundary. These describe the shape the bot
// actually relies on at the seam (runJulesStream / deliveryCursor / sessionInfo)
// rather than `any`. They are intentionally structural: the SDK's runtime
// SessionClient exposes `info/activities/send/result`, the bot also reads an
// optional `sessionStorage` (guarded at call sites) and calls `result` with a
// timeout option, so those are modeled as optional/loose here.

export type JulesActivity = {
  id: string
  type: string
  createTime?: string
  originator?: 'user' | 'agent' | 'system'
  // Flat fields used directly by the handlers.
  message?: string
  plan?: { steps?: { title?: string; description?: string }[] }
  title?: string
  description?: string
  reason?: string
  url?: string
  // Legacy nested variants some activity payloads still arrive with.
  agentMessaged?: { message?: string }
  planGenerated?: { plan?: { steps?: { title?: string }[] } }
  progressUpdated?: { title?: string; description?: string }
  sessionFailed?: { reason?: string }
  userMessaged?: unknown
}

export interface JulesSessionInfo {
  state?: SessionState
  url?: string
}

export interface JulesSession {
  id: string
  info(): Promise<JulesSessionInfo>
  send(prompt: string): Promise<void>
  approve(): Promise<void>
  result(opts?: { timeoutMs?: number }): Promise<Outcome | null>
  activities: {
    hydrate(): Promise<number>
    select(options?: { order?: 'asc' | 'desc' }): Promise<JulesActivity[]>
  }
  sessionStorage?: {
    delete(id: string): Promise<void>
  }
}
