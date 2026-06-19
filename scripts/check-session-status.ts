import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { jules } from '@google/jules-sdk'
import 'dotenv/config'

const DATABASE_URL = 'file:./prisma/dev.db'
const adapter = new PrismaBetterSqlite3({ url: DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const JULES_API_KEY = process.env.JULES_API_KEY
const client = JULES_API_KEY ? jules.with({ apiKey: JULES_API_KEY }) : jules

async function main() {
  const sessions = await prisma.debugSession.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  })

  console.log(`Checking status for ${sessions.length} most recent sessions...\n`)

  for (const s of sessions) {
    try {
      const session = client.session(s.julesSessionId)
      const info = await session.info()

      console.log(`- Thread ID: ${s.threadId}`)
      console.log(`  Repo: ${s.repoName}`)
      console.log(`  State: ${info.state}`)

      if (info.activities && info.activities.length > 0) {
        const lastActivity = info.activities[info.activities.length - 1]
        console.log(
          `  Last Activity: ${lastActivity.type} (${new Date(lastActivity.timestamp).toLocaleTimeString()})`,
        )
      }

      console.log(`  Created: ${s.createdAt}`)
      console.log('---')
    } catch (err) {
      console.log(`- Thread ID: ${s.threadId}`)
      console.log(`  Error fetching Jules info: ${err.message}`)
      console.log('---')
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
