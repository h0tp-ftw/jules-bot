import { prisma } from './src/config.js'

async function main() {
  const configs = await prisma.guildConfig.findMany()
  console.log('--- GuildConfigs ---')
  console.log(JSON.stringify(configs, null, 2))

  const sessions = await prisma.debugSession.findMany()
  console.log('\n--- DebugSessions ---')
  console.log(JSON.stringify(sessions, null, 2))
}

main().catch(console.error).finally(() => prisma.$disconnect())
