import fs from 'fs'
import path from 'path'
import readline from 'node:readline'
import { execSync } from 'node:child_process'
import { inviteUrl } from './lib/invite.js'

// Interactive, plug-n-play first-run wizard for non-Docker installs. From a fresh
// clone, `npm run setup` will:
//   1. prompt for the Discord token and validate it live (then print a
//      ready-to-click invite link with the exact permissions the bot needs),
//   2. prompt for + validate the Jules API key (lists your connected repos),
//   3. write .env + copy the runtime config templates,
//   4. install dependencies and provision the SQLite database,
//   5. offer to start the bot.
// It uses only Node built-ins (+ global fetch) so it runs before `npm install`,
// and falls back to copy-only in a non-interactive shell (CI).

const templateFiles = [
  { src: 'templates/config.example.yaml', dest: 'config.yaml' },
  { src: 'templates/AGENTS.example.md', dest: 'AGENTS.md' },
  { src: 'templates/SOUL.example.md', dest: 'SOUL.md' },
]

const ENV_TEMPLATE = 'templates/.env.example'
const ENV_DEST = '.env'
const DEFAULT_DATABASE_URL = 'file:./prisma/dev.db'

// Prompt helper. When `mask` is set, typed characters are hidden (for secrets).
function ask(query, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    })
    let muted = false
    if (mask) {
      const out = rl.output
      rl._writeToOutput = (str) => {
        if (!muted) out.write(str)
      }
    }
    rl.question(query, (answer) => {
      if (mask) rl.output.write('\n')
      rl.close()
      resolve(answer.trim())
    })
    muted = mask
  })
}

async function askYesNo(query, defaultYes = true) {
  const answer = (await ask(`${query} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase()
  if (!answer) return defaultYes
  return answer === 'y' || answer === 'yes'
}

function readEnvValue(key) {
  const envPath = path.resolve(ENV_DEST)
  if (!fs.existsSync(envPath)) return undefined
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith(`${key}=`))
  if (!line) return undefined
  let val = line.slice(line.indexOf('=') + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  return val
}

async function validateDiscordToken(token) {
  if (typeof fetch !== 'function') return { ok: false, skipped: true }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, user: await res.json() }
  } catch (err) {
    return { ok: false, error: err }
  } finally {
    clearTimeout(timer)
  }
}

async function validateJulesKey(key) {
  try {
    const { jules } = await import('@google/jules-sdk')
    const client = jules.with({ apiKey: key, config: { requestTimeoutMs: 15000 } })
    const repos = []
    for await (const source of client.sources()) {
      if (source.type === 'githubRepo') {
        repos.push(`${source.githubRepo.owner}/${source.githubRepo.repo}`)
      }
      if (repos.length >= 25) break
    }
    return { ok: true, repos }
  } catch (err) {
    return { ok: false, error: err }
  }
}

function run(cmd, label) {
  try {
    console.log(`\n  ▸ ${label || cmd}`)
    execSync(cmd, { stdio: 'inherit', env: process.env })
    return true
  } catch {
    console.error(`  ❌  Command failed: ${cmd}`)
    return false
  }
}

function copyIfMissing(src, dest) {
  const srcPath = path.resolve(src)
  const destPath = path.resolve(dest)
  if (!fs.existsSync(srcPath)) {
    console.warn(`  ⚠️   Template ${src} not found. Skipping.`)
    return
  }
  if (fs.existsSync(destPath)) {
    console.log(`  ✅  ${dest} already exists — left untouched.`)
    return
  }
  try {
    fs.copyFileSync(srcPath, destPath)
    console.log(`  ✨  Created ${dest}`)
  } catch (err) {
    console.error(`  ❌  Failed to copy ${src} → ${dest}:`, err)
  }
}

async function promptDiscord() {
  console.log('\n🔑 Discord credentials')
  console.log('   • Create an app + bot:  https://discord.com/developers/applications')
  console.log('   • On the Bot page, enable the "Message Content Intent" toggle')
  console.log('   • Reset/copy the bot token, then paste it below\n')

  let token
  let clientId = ''
  for (let attempt = 1; ; attempt++) {
    token = await ask('  Discord bot token  › ', { mask: true })
    if (!token) {
      console.log('  (skipped — set DISCORD_TOKEN in .env later)')
      break
    }
    process.stdout.write('  …validating… ')
    const result = await validateDiscordToken(token)
    if (result.ok) {
      const u = result.user
      clientId = u.id
      const tag =
        u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username
      console.log(`✓ logged in as ${tag}`)
      break
    }
    if (result.skipped) {
      console.log('(fetch unavailable — skipping validation)')
      break
    }
    const why =
      result.status === 401
        ? 'Discord rejected it (401 Unauthorized)'
        : result.status
          ? `HTTP ${result.status}`
          : 'network error'
    console.log(`✗ ${why}`)
    if (attempt >= 3 || !(await askYesNo('  Try a different token?', true))) {
      console.log('  Keeping the token as entered — double-check it in .env.')
      break
    }
  }

  if (!clientId) {
    const provided = await ask('  Application (Client) ID for the invite link (optional) › ')
    if (provided) clientId = provided
  }
  if (clientId) {
    console.log('\n  📨 Invite the bot to your server (grants the permissions it needs):')
    console.log(`     ${inviteUrl(clientId)}`)
  }
  return token
}

function writeEnv({ discordToken, julesKey, logLevel, devGuildId }) {
  const srcPath = path.resolve(ENV_TEMPLATE)
  if (!fs.existsSync(srcPath)) {
    console.warn(`  ⚠️   ${ENV_TEMPLATE} not found — cannot create .env.`)
    return
  }
  let content = fs.readFileSync(srcPath, 'utf8')
  if (discordToken) content = content.replace('YOUR_DISCORD_TOKEN', discordToken)
  if (julesKey) content = content.replace('YOUR_JULES_API_KEY', julesKey)
  if (logLevel) content = content.replace(/^LOG_LEVEL=.*$/m, `LOG_LEVEL="${logLevel}"`)
  if (devGuildId)
    content = content.replace(/^#?\s*DEV_GUILD_ID=.*$/m, `DEV_GUILD_ID="${devGuildId}"`)
  fs.writeFileSync(path.resolve(ENV_DEST), content)
  console.log(`  ✨  Wrote ${ENV_DEST}`)
}

// No-prompt path for scripted installs / CI. Sources tokens from the
// environment (DISCORD_TOKEN, JULES_API_KEY, LOG_LEVEL, DEV_GUILD_ID).
async function runNonInteractive({ full }) {
  console.log(`Non-interactive setup${full ? ' (--yes)' : ' shell'}.\n`)

  // .env — substitute any tokens provided via env; leave placeholders for the
  // rest. Never clobber an existing .env.
  if (fs.existsSync(path.resolve(ENV_DEST))) {
    console.log('  ✅  .env already exists — left untouched.')
  } else {
    writeEnv({
      discordToken: process.env.DISCORD_TOKEN,
      julesKey: process.env.JULES_API_KEY,
      logLevel: process.env.LOG_LEVEL,
      devGuildId: process.env.DEV_GUILD_ID,
    })
    const missing = ['DISCORD_TOKEN', 'JULES_API_KEY'].filter((k) => !process.env[k])
    if (missing.length) {
      console.log(`  ⚠️   ${missing.join(' / ')} not in env — placeholder(s) left in .env.`)
    }
  }

  for (const { src, dest } of templateFiles) copyIfMissing(src, dest)

  // --yes also installs deps + provisions the DB; a bare non-TTY run only writes
  // config so it can't surprise a pipeline with a long install.
  if (full) {
    if (!fs.existsSync(path.resolve('node_modules'))) {
      run('npm install', 'Installing dependencies (npm install)…')
    }
    if (fs.existsSync(path.resolve('node_modules/.bin/prisma'))) {
      process.env.DATABASE_URL = readEnvValue('DATABASE_URL') || DEFAULT_DATABASE_URL
      run('npx prisma generate', 'Generating Prisma client…')
      run('npx prisma migrate deploy', 'Provisioning the database…')
    }
  }

  console.log('\n✅ Setup complete. Start with: npm run dev  (or  npm run build && npm start)')
}

async function main() {
  console.log('🐙 JulesBot setup\n')

  const args = process.argv.slice(2)
  const yes = args.includes('--yes') || args.includes('-y')
  if (yes || !process.stdin.isTTY) {
    await runNonInteractive({ full: yes })
    return
  }

  const major = Number(process.versions.node.split('.')[0])
  console.log(`Node.js ${process.versions.node} ${major < 20 ? '⚠️  (need >= 20)' : '✓'}`)

  // 1. Credentials → .env
  const envExists = fs.existsSync(path.resolve(ENV_DEST))
  let reconfigure = !envExists
  if (envExists) {
    reconfigure = await askYesNo('\nFound an existing .env — reconfigure it (overwrites)?', false)
  }
  if (reconfigure) {
    const discordToken = await promptDiscord()
    console.log('\n🔑 Jules API key')
    console.log('   • Get an API key from Jules:  https://jules.google.com\n')
    const julesKey = await ask('  Jules API key  › ', { mask: true })
    const logLevel = (await ask('  Log level [info]  › ')) || 'info'
    const devGuildId = await ask('  Dev guild ID for instant slash commands (optional) › ')
    console.log('')
    writeEnv({ discordToken, julesKey, logLevel, devGuildId })
  } else {
    console.log('  ✅  Keeping existing .env.')
  }

  // 2. Runtime config files
  console.log('\n📄 Runtime config files')
  for (const { src, dest } of templateFiles) copyIfMissing(src, dest)

  // 3. Dependencies
  if (!fs.existsSync(path.resolve('node_modules'))) {
    if (await askYesNo('\nInstall dependencies now (npm install)?', true)) {
      run('npm install', 'Installing dependencies (npm install)…')
    }
  } else {
    console.log('\n  ✅  Dependencies already installed.')
  }

  const depsReady = fs.existsSync(path.resolve('node_modules'))

  // 4. Validate the Jules key now that the SDK is available.
  const julesKey = readEnvValue('JULES_API_KEY')
  if (
    depsReady &&
    julesKey &&
    julesKey !== 'YOUR_JULES_API_KEY' &&
    fs.existsSync(path.resolve('node_modules/@google/jules-sdk'))
  ) {
    process.stdout.write('\n  …validating Jules API key… ')
    const res = await validateJulesKey(julesKey)
    if (res.ok) {
      console.log(
        res.repos.length
          ? `✓ valid — connected repos: ${res.repos.join(', ')}`
          : '✓ valid (no repos connected in Jules yet)',
      )
    } else {
      console.log('✗ could not validate — check the key/network. The bot re-checks on start.')
    }
  }

  // 5. Database + Prisma client.
  if (depsReady && fs.existsSync(path.resolve('node_modules/.bin/prisma'))) {
    process.env.DATABASE_URL = readEnvValue('DATABASE_URL') || DEFAULT_DATABASE_URL
    run('npx prisma generate', 'Generating Prisma client…')
    run('npx prisma migrate deploy', 'Provisioning the database…')
  }

  // 6. Done — offer to start (dev or production).
  console.log('\n✅ Setup complete.')
  if (depsReady && (await askYesNo('\nStart the bot now?', true))) {
    const prod = await askYesNo(
      '  Production mode (build + start)? Otherwise dev (hot reload).',
      false,
    )
    console.log('\nStarting JulesBot… (Ctrl+C to stop)\n')
    try {
      if (prod) {
        if (run('npm run build', 'Building (tsc)…')) {
          execSync('npm start', { stdio: 'inherit', env: process.env })
        }
      } else {
        execSync('npm run dev', { stdio: 'inherit', env: process.env })
      }
    } catch {
      // bot process exited (e.g. Ctrl+C) — nothing to clean up here
    }
    return
  }

  console.log('\nNext steps:')
  console.log('  • npm run doctor              # verify configuration')
  console.log('  • npm run dev                 # start in dev (hot reload)')
  console.log('  • npm run build && npm start  # production')
}

main()
