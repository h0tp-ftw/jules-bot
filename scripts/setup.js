import fs from 'fs'
import path from 'path'

const filesToCopy = [
  { src: 'templates/.env.example', dest: '.env' },
  { src: 'templates/config.example.yaml', dest: 'config.yaml' },
  { src: 'templates/AGENTS.example.md', dest: 'AGENTS.md' },
  { src: 'templates/SOUL.example.md', dest: 'SOUL.md' }
]

console.log('🐙 Initializing JulesBot Local Environment...')

for (const { src, dest } of filesToCopy) {
  const srcPath = path.resolve(src)
  const destPath = path.resolve(dest)

  if (!fs.existsSync(srcPath)) {
    console.warn(`⚠️  Source file ${src} does not exist. Skipping.`)
    continue
  }

  if (fs.existsSync(destPath)) {
    console.log(`✅  ${dest} already exists.`)
  } else {
    try {
      fs.copyFileSync(srcPath, destPath)
      console.log(`✨  Created ${dest} from ${src}`)
    } catch (err) {
      console.error(`❌  Failed to copy ${src} to ${dest}:`, err)
    }
  }
}

console.log('\n🎉  Setup complete! Remember to fill in API tokens in .env.')
