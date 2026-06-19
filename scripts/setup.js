import fs from 'fs'
import path from 'path'
import readline from 'node:readline'

// Interactive first-run setup. Copies the gitignored runtime files from their
// committed templates and, on a fresh install, prompts for the two required
// secrets so `.env` comes out ready to run — no hand-editing required.

const templateFiles = [
  { src: 'templates/config.example.yaml', dest: 'config.yaml' },
  { src: 'templates/AGENTS.example.md', dest: 'AGENTS.md' },
  { src: 'templates/SOUL.example.md', dest: 'SOUL.md' },
]

const ENV_TEMPLATE = 'templates/.env.example'
const ENV_DEST = '.env'

function copyIfMissing(src, dest) {
  const srcPath = path.resolve(src)
  const destPath = path.resolve(dest)
  if (!fs.existsSync(srcPath)) {
    console.warn(`⚠️  Source file ${src} does not exist. Skipping.`)
    return
  }
  if (fs.existsSync(destPath)) {
    console.log(`✅  ${dest} already exists — left untouched.`)
    return
  }
  try {
    fs.copyFileSync(srcPath, destPath)
    console.log(`✨  Created ${dest} from ${src}`)
  } catch (err) {
    console.error(`❌  Failed to copy ${src} to ${dest}:`, err)
  }
}

// Prompt helper. When `mask` is set, typed characters are hidden (for secrets).
function ask(query, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
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

async function writeEnv() {
  const destPath = path.resolve(ENV_DEST)
  if (fs.existsSync(destPath)) {
    console.log('✅  .env already exists — skipping token prompts (delete it to re-run).')
    return
  }

  const srcPath = path.resolve(ENV_TEMPLATE)
  if (!fs.existsSync(srcPath)) {
    console.warn(`⚠️  ${ENV_TEMPLATE} not found. Skipping .env generation.`)
    return
  }

  console.log('\nLet’s fill in your .env (press Enter to leave a value as the placeholder):\n')
  const discordToken = await ask('  Discord bot token       › ', { mask: true })
  const julesKey = await ask('  Jules API key            › ', { mask: true })
  const logLevel = (await ask('  Log level [info]         › ')) || 'info'
  const devGuildId = await ask('  Dev guild ID (optional)  › ')

  let content = fs.readFileSync(srcPath, 'utf8')
  if (discordToken) content = content.replace('YOUR_DISCORD_TOKEN', discordToken)
  if (julesKey) content = content.replace('YOUR_JULES_API_KEY', julesKey)
  content = content.replace(/^LOG_LEVEL=.*$/m, `LOG_LEVEL="${logLevel}"`)
  if (devGuildId) {
    content = content.replace(/^#?\s*DEV_GUILD_ID=.*$/m, `DEV_GUILD_ID="${devGuildId}"`)
  }

  try {
    fs.writeFileSync(destPath, content)
    console.log(`✨  Created ${ENV_DEST}`)
  } catch (err) {
    console.error(`❌  Failed to write ${ENV_DEST}:`, err)
  }
}

async function main() {
  console.log('🐙 Initializing JulesBot local environment...\n')

  await writeEnv()
  for (const { src, dest } of templateFiles) {
    copyIfMissing(src, dest)
  }

  console.log('\n🎉  Setup complete.')
  console.log('    Next: `npm install` → `npm run doctor` → `npm run dev`')
}

main()
