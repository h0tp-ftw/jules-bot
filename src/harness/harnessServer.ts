import http from 'node:http'
import { HarnessSession, type HarnessSessionOptions } from './harnessSession.js'
import { logger } from '../lib/utils/logger.js'

export const activeHarnessSessions = new Map<string, HarnessSession>()

export function createHarnessHttpServer(): http.Server {
  return http.createServer(async (req, res) => {
    // Set standard CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    try {
      // 1. Health check
      if (pathname === '/health' || pathname === '/api/harness/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            status: 'ok',
            activeSessions: activeHarnessSessions.size,
          }),
        )
        return
      }

      // Helper to parse JSON body
      const parseJsonBody = async <T>(): Promise<T> => {
        return new Promise((resolve, reject) => {
          let body = ''
          req.on('data', (chunk) => {
            body += chunk
          })
          req.on('end', () => {
            try {
              resolve(body ? JSON.parse(body) : {})
            } catch (err) {
              reject(err)
            }
          })
          req.on('error', reject)
        })
      }

      // 2. List sessions: GET /api/harness/sessions
      if (req.method === 'GET' && pathname === '/api/harness/sessions') {
        const list = Array.from(activeHarnessSessions.entries()).map(([id, s]) => ({
          sessionId: id,
          julesSessionId: s.julesSessionId,
          repo: s.repo,
          branch: s.branch,
          mode: s.mode,
          channelId: s.virtualChannel.id,
          messageCount: s.virtualChannel.getAllMessages().length,
          eventCount: s.events.length,
        }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessions: list }))
        return
      }

      // 3. Create session: POST /api/harness/sessions
      if (req.method === 'POST' && pathname === '/api/harness/sessions') {
        const body = await parseJsonBody<
          HarnessSessionOptions & { waitForFirstReply?: boolean; timeoutMs?: number }
        >()
        const session = new HarnessSession(body)
        activeHarnessSessions.set(session.id, session)

        logger.info(`[HarnessServer] Creating new session ${session.id}`)
        let firstReply: string | null = null

        if (body.waitForFirstReply) {
          const replyPromise = new Promise<string>((resolve) => {
            session.once('agent_reply', (data: { content: string }) => resolve(data.content))
          })
          await session.init(body.initialPrompt)
          const timeoutMs = body.timeoutMs || 120000
          firstReply = await Promise.race([
            replyPromise,
            new Promise<null>((resTimeout) => setTimeout(() => resTimeout(null), timeoutMs)),
          ])
        } else {
          await session.init(body.initialPrompt)
        }

        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            sessionId: session.id,
            julesSessionId: session.julesSessionId,
            channelId: session.virtualChannel.id,
            firstReply,
          }),
        )
        return
      }

      // Dynamic routes: /api/harness/sessions/:id/...
      const sessionMatch = pathname.match(/^\/api\/harness\/sessions\/([^/]+)(.*)$/)
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1])
        const subPath = sessionMatch[2]
        const session = activeHarnessSessions.get(sessionId)

        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Session ${sessionId} not found` }))
          return
        }

        // GET /api/harness/sessions/:id
        if (req.method === 'GET' && (!subPath || subPath === '/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              sessionId: session.id,
              julesSessionId: session.julesSessionId,
              repo: session.repo,
              branch: session.branch,
              mode: session.mode,
              transcript: session.getTranscript(),
            }),
          )
          return
        }

        // DELETE /api/harness/sessions/:id
        if (req.method === 'DELETE' && (!subPath || subPath === '/')) {
          await session.close()
          activeHarnessSessions.delete(sessionId)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: `Session ${sessionId} deleted` }))
          return
        }

        // POST /api/harness/sessions/:id/messages
        if (req.method === 'POST' && subPath === '/messages') {
          const body = await parseJsonBody<{
            content: string
            waitForReply?: boolean
            timeoutMs?: number
          }>()
          if (!body.content) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'content is required' }))
            return
          }

          if (body.waitForReply) {
            const startMs = Date.now()
            try {
              const reply = await session.sendUserMessage(body.content, body.timeoutMs || 120000)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  reply,
                  latencyMs: Date.now() - startMs,
                }),
              )
            } catch (err: any) {
              res.writeHead(504, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: err.message, latencyMs: Date.now() - startMs }))
            }
          } else {
            void session.sendUserMessage(body.content).catch((err) => {
              logger.error(`[HarnessServer] Error sending async message for ${sessionId}:`, err)
            })
            res.writeHead(202, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'dispatched' }))
          }
          return
        }

        // GET /api/harness/sessions/:id/events (Server-Sent Events)
        if (req.method === 'GET' && subPath === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`)

          // Send historical events first
          for (const evt of session.events) {
            res.write(`data: ${JSON.stringify(evt)}\n\n`)
          }

          const onEvent = (evt: any) => {
            res.write(`data: ${JSON.stringify(evt)}\n\n`)
          }

          session.on('event', onEvent)

          req.on('close', () => {
            session.off('event', onEvent)
          })
          return
        }

        // POST /api/harness/sessions/:id/approve
        if (req.method === 'POST' && subPath === '/approve') {
          await session.approvePlan()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'approved' }))
          return
        }

        // POST /api/harness/sessions/:id/reject
        if (req.method === 'POST' && subPath === '/reject') {
          const body = await parseJsonBody<{ feedback?: string }>()
          await session.rejectPlan(body.feedback)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'rejected' }))
          return
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Endpoint not found' }))
    } catch (err: any) {
      logger.error('[HarnessServer] Request error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message || 'Internal server error' }))
    }
  })
}

let harnessServerInstance: http.Server | null = null

export function startHarnessServer(port: number, host = '0.0.0.0'): http.Server {
  if (harnessServerInstance) return harnessServerInstance
  const server = createHarnessHttpServer()
  server.listen(port, host, () => {
    logger.info(
      `[Harness] Interactive testing server listening on http://${host}:${port}/api/harness/sessions`,
    )
  })
  harnessServerInstance = server
  return server
}

export function stopHarnessServer(): void {
  if (harnessServerInstance) {
    try {
      harnessServerInstance.close()
    } catch {
      /* ignore */
    }
    harnessServerInstance = null
  }
}
