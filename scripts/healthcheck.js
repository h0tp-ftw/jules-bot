import http from 'node:http'

// Container HEALTHCHECK probe. Hits the in-process /health endpoint and exits 0
// only on HTTP 200 (gateway connected AND DB reachable). Used by docker-compose.

const port = process.env.HEALTHCHECK_PORT || 3000

const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 4000 }, (res) => {
  res.resume()
  process.exit(res.statusCode === 200 ? 0 : 1)
})

req.on('error', () => process.exit(1))
req.on('timeout', () => {
  req.destroy()
  process.exit(1)
})
