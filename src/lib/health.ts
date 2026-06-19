import http from 'node:http'
import type { Client } from 'discord.js'
import { logger } from './utils/logger.js'
import { prisma } from '../config.js'

// Optional liveness/readiness endpoint for Docker, k8s, or an uptime monitor.
// Opt-in via HEALTHCHECK_PORT. GET /health returns JSON and a 200 only when the
// Discord gateway is connected AND SQLite is reachable — this catches the
// "process alive but gateway dropped" zombie that a bare PID check misses.

let server: http.Server | null = null
const startedAt = Date.now()

export function startHealthServer(client: Client, port: number): http.Server | null {
  if (server) return server

  server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/health')) {
      res.writeHead(404).end()
      return
    }

    const gatewayReady = client.isReady()
    let dbReachable = false
    try {
      await prisma.$queryRawUnsafe('SELECT 1')
      dbReachable = true
    } catch {
      dbReachable = false
    }

    const healthy = gatewayReady && dbReachable
    const body = JSON.stringify({
      status: healthy ? 'ok' : 'degraded',
      gateway: gatewayReady ? 'connected' : 'connecting',
      db: dbReachable ? 'reachable' : 'unreachable',
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    })
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
    res.end(body)
  })

  server.on('error', (err) => {
    logger.error('[Health] HTTP server error:', err)
  })

  server.listen(port, () => {
    logger.info(`[Health] Liveness endpoint listening on http://0.0.0.0:${port}/health`)
  })

  return server
}

export function stopHealthServer(): void {
  if (!server) return
  try {
    server.close()
  } catch {
    /* already closing */
  }
  server = null
}
