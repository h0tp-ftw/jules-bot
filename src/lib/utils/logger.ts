// Minimal level-gated logger. Routes through console (so pm2/journald capture it
// as before) but lets a `LOG_LEVEL` env var silence the verbose per-activity
// tracing in production. Levels, low→high: debug < info < warn < error.
//
//   LOG_LEVEL=debug  → everything (the default for `npm run dev`)
//   LOG_LEVEL=info   → lifecycle + warnings + errors (the default otherwise)
//   LOG_LEVEL=warn   → warnings + errors only
//   LOG_LEVEL=error  → errors only
//
// The threshold is read fresh on each call rather than cached at module load, so
// it is unaffected by import order (e.g. dotenv running after this module) and a
// profile's .env can still set it.

type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL || 'info').toLowerCase()
  return ORDER[lvl as Level] ?? ORDER.info
}

function emit(level: Level, args: unknown[]): void {
  if (ORDER[level] < threshold()) return
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  sink(...args)
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
}
