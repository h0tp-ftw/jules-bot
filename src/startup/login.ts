import { logger } from '../lib/utils/logger.js'
import type { Client } from 'discord.js'

/** Error codes that indicate a transient network condition worth retrying. */
const NETWORK_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ENETUNREACH',
])

function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as any).code as string | undefined
  if (code && NETWORK_ERROR_CODES.has(code)) return true
  const msg: string = (err as any).message ?? ''
  return /connect timeout|econnrefused|enotfound|etimedout|econnreset/i.test(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getSessionWaitTime(msg: string): number {
  const match = msg.match(/resets at ([\d\-:TZ.]+)/i)
  if (match) {
    const resetTime = new Date(match[1])
    const diff = resetTime.getTime() - Date.now()
    if (diff > 0) {
      return diff + 5_000 // 5s safety margin
    }
  }
  return 30 * 60 * 1_000 // Fallback to 30 minutes
}

/**
 * Attempts client.login() with exponential backoff on transient network errors.
 * Delay schedule: 5 s → 10 s → 20 s → … capped at 120 s.
 * Non-network errors are rethrown immediately so the caller can exit cleanly.
 */
export async function loginWithRetry(
  client: Client,
  token: string,
  attempt = 0,
): Promise<void> {
  try {
    await client.login(token)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)

    // Discord daily session identification limit exhausted (often 1000 per 24 hours).
    // Sleep through the reset period instead of crashing the process to avoid PM2 infinite restart loops.
    if (msg.includes('sessions remaining') || msg.includes('Not enough sessions')) {
      const waitMs = getSessionWaitTime(msg)
      const waitMins = Math.ceil(waitMs / 60_000)
      logger.error(
        `[Startup] Discord daily session limit exhausted. Resets in ${waitMins} minutes. Sleeping through cooldown...`,
      )

      const checkInterval = 5 * 60 * 1_000 // log status every 5 minutes
      let elapsed = 0
      while (elapsed < waitMs) {
        const remainingMins = Math.ceil((waitMs - elapsed) / 60_000)
        logger.info(`[Startup] Session limit cooldown status: ${remainingMins} minutes remaining.`)
        const chunk = Math.min(checkInterval, waitMs - elapsed)
        await sleep(chunk)
        elapsed += chunk
      }

      logger.info('[Startup] Cooldown finished, retrying Discord login...')
      return loginWithRetry(client, token, 0)
    }

    if (isNetworkError(err)) {
      const delaySec = Math.min(5 * 2 ** attempt, 120)
      logger.warn(
        `[Startup] Discord login failed (network error, attempt ${attempt + 1}) — retrying in ${delaySec}s`,
      )
      logger.debug('[Startup] Login failure detail:', err)
      await sleep(delaySec * 1_000)
      return loginWithRetry(client, token, attempt + 1)
    }
    // Non-network error (bad token, auth rejected, etc.) — propagate immediately.
    throw err
  }
}
