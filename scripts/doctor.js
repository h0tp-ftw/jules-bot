import 'dotenv/config'
import fs from 'fs'
import path from 'path'

// Pre-flight check. Verifies the environment is configured before the bot is
// started, and prints a clear next step for anything missing. Dependency-light
// and side-effect-free — safe to run anytime (`npm run doctor`).

let problems = 0

function ok(msg) {
  console.log(`  ✅  ${msg}`)
}
function warn(msg, hint) {
  console.log(`  ⚠️   ${msg}${hint ? `\n        → ${hint}` : ''}`)
}
function fail(msg, hint) {
  problems++
  console.log(`  ❌  ${msg}${hint ? `\n        → ${hint}` : ''}`)
}

console.log('🩺 JulesBot doctor\n')

// Node version (engines: >=20)
const major = Number(process.versions.node.split('.')[0])
if (major >= 20) ok(`Node.js ${process.versions.node}`)
else fail(`Node.js ${process.versions.node} is too old`, 'Install Node.js 20 or newer (see .nvmrc).')

// Runtime files
if (fs.existsSync(path.resolve('.env'))) ok('.env present')
else warn('.env missing', 'Fine if you inject env vars another way (Docker/systemd); otherwise run `npm run setup`.')

if (fs.existsSync(path.resolve('config.yaml'))) ok('config.yaml present')
else warn('config.yaml missing', 'Defaults from templates/config.example.yaml will be used.')

// Secrets
const discord = process.env.DISCORD_TOKEN
if (discord && discord !== 'YOUR_DISCORD_TOKEN') ok('DISCORD_TOKEN set')
else fail('DISCORD_TOKEN not configured', 'Add it to .env (Discord Developer Portal → Bot → Token).')

const jules = process.env.JULES_API_KEY
if (jules && jules !== 'YOUR_JULES_API_KEY') ok('JULES_API_KEY set')
else fail('JULES_API_KEY not configured', 'Add it to .env (Jules API key).')

// Database
const dbUrl = process.env.DATABASE_URL || 'file:./prisma/dev.db'
if (dbUrl.startsWith('file:')) {
  const dbPath = path.resolve(dbUrl.slice(5))
  if (fs.existsSync(dbPath)) ok(`SQLite database present (${dbUrl})`)
  else warn(`SQLite database not found (${dbUrl})`, 'It is auto-provisioned on first boot — no action needed.')
} else {
  ok(`DATABASE_URL set (${dbUrl})`)
}

// Prisma client generated
if (fs.existsSync(path.resolve('node_modules/.prisma/client')) || fs.existsSync(path.resolve('node_modules/@prisma/client'))) {
  ok('Prisma client generated')
} else {
  warn('Prisma client not generated', 'Run `npm run db:generate` (or `npm install`).')
}

console.log('')
if (problems === 0) {
  console.log('✨ All required checks passed — `npm run dev` should start cleanly.')
  process.exit(0)
} else {
  console.log(`🛑 ${problems} blocking issue(s) found — fix the ❌ items above, then re-run \`npm run doctor\`.`)
  process.exit(1)
}
