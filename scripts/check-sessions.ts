import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

const DATABASE_URL = 'file:./prisma/dev.db'
const adapter = new PrismaBetterSqlite3({ url: DATABASE_URL })
const prisma = new PrismaClient({ adapter })

async function main() {
  const sessions = await prisma.debugSession.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  console.log(`Found ${sessions.length} recent debug sessions:\n`)
  for (const s of sessions) {
    console.log(`- Thread ID: ${s.threadId}`)
    console.log(`  Repo: ${s.repoName}`)
    console.log(`  Jules Session: ${s.julesSessionId}`)
    console.log(`  Created: ${s.createdAt}`)
    console.log('---')
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
