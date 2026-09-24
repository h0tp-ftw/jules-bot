#!/usr/bin/env tsx
import 'dotenv/config'
import readline from 'node:readline'
import { HarnessSession } from '../src/harness/harnessSession.js'
import { startHarnessServer } from '../src/harness/harnessServer.js'
import { prisma } from '../src/config.js'

function parseArgs() {
  const args = process.argv.slice(2)
  const options: Record<string, any> = {
    query: undefined,
    json: false,
    server: false,
    port: 3100,
    url: undefined,
    repo: 'h0tp-ftw/ankimon',
    branch: 'main',
    channel: '1382329537676705792',
    mode: 'chatbot' as 'chatbot' | 'forum',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--query' || arg === '-q') {
      options.query = args[++i]
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--server' || arg === '-s') {
      options.server = true
    } else if (arg === '--port' || arg === '-p') {
      options.port = Number(args[++i]) || 3100
    } else if (arg === '--url' || arg === '-u') {
      options.url = args[++i]
    } else if (arg === '--repo' || arg === '-r') {
      options.repo = args[++i]
    } else if (arg === '--branch' || arg === '-b') {
      options.branch = args[++i]
    } else if (arg === '--channel' || arg === '-c') {
      options.channel = args[++i]
    } else if (arg === '--mode' || arg === '-m') {
      const m = args[++i]
      if (m === 'chatbot' || m === 'forum') options.mode = m
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
JulesBot Interactive Testing Harness

Usage:
  npx tsx scripts/test-harness.ts [options]

Options:
  -q, --query <text>     Ask a single question and output response
  --json                 Output results as JSON (ideal for AI test scripts)
  -u, --url <url>        Connect to a remote running JulesBot harness server (e.g. http://100.94.190.37:3100)
  -s, --server           Start the HTTP harness server
  -p, --port <number>    Port for HTTP server (default: 3100)
  -r, --repo <repo>      Target repository (default: h0tp-ftw/ankimon)
  -b, --branch <branch>  Base branch (default: main)
  -c, --channel <id>     Simulated Discord channel ID (default: 1382329537676705792)
  -m, --mode <mode>      Session mode: 'chatbot' or 'forum' (default: chatbot)
  -h, --help             Show this help message
`)
      process.exit(0)
    }
  }

  return options
}

async function runRemoteQuery(baseUrl: string, query: string, options: any) {
  const cleanUrl = baseUrl.replace(/\/+$/, '')
  const createRes = await fetch(`${cleanUrl}/api/harness/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: options.repo,
      branch: options.branch,
      channelId: options.channel,
      mode: options.mode,
      initialPrompt: query,
      waitForFirstReply: true,
      timeoutMs: 180000,
    }),
  })

  if (!createRes.ok) {
    throw new Error(`Failed to create remote session: ${createRes.status} ${createRes.statusText}`)
  }

  const sessionData = await createRes.json()
  return sessionData
}

async function runLocalQuery(query: string, options: any) {
  await prisma.$connect()
  const session = new HarnessSession({
    repo: options.repo,
    branch: options.branch,
    channelId: options.channel,
    mode: options.mode,
  })

  let finalReply = ''
  let planProposed = false

  session.on('plan_proposed', () => {
    planProposed = true
  })

  session.on('plan_auto_rejected', (data) => {
    if (!options.json) {
      console.log('\n[Auto-Reject] Plan detected and auto-reject feedback sent:', data.content)
    }
  })

  session.on('status_edit', (data) => {
    if (!options.json) {
      process.stdout.write(`\r[Jules Status] ${data.content.slice(0, 80).replace(/\n/g, ' ')}...`)
    }
  })

  const replyPromise = new Promise<string>((resolve) => {
    session.once('agent_reply', (data: { content: string }) => {
      finalReply = data.content
      resolve(data.content)
    })
  })

  const startTime = Date.now()
  await session.init(query)

  // Wait for reply or timeout
  await Promise.race([
    replyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Turn timeout')), 180000)),
  ])

  const latencyMs = Date.now() - startTime

  return {
    reply: finalReply,
    planProposed,
    latencyMs,
    transcript: session.getTranscript(),
  }
}

async function startInteractiveRepl(options: any) {
  console.log(`\n🐙 Starting JulesBot Interactive Testing Session`)
  console.log(`• Repo:    ${options.repo}`)
  console.log(`• Branch:  ${options.branch}`)
  console.log(`• Channel: ${options.channel} (${options.mode} mode)`)
  console.log(`Type your question and press Enter. Type 'exit' to quit.\n`)

  await prisma.$connect()
  const session = new HarnessSession({
    repo: options.repo,
    branch: options.branch,
    channelId: options.channel,
    mode: options.mode,
  })

  session.on('plan_proposed', (data) => {
    console.log(`\n⚠️  [Plan Generated] Proposed diagnostic plan:`)
    for (const embed of data.embeds || []) {
      console.log(embed.data?.description || JSON.stringify(embed))
    }
  })

  session.on('plan_auto_rejected', (data) => {
    console.log(`\n🤖 [Auto-Reject Feedback Sent]: ${data.content}`)
  })

  session.on('reaction', (data) => {
    console.log(`\n[Reaction Added]: ${data.emoji}`)
  })

  session.on('status_edit', (data) => {
    const summary = data.content.split('\n')[0]
    process.stdout.write(`\r⏳ ${summary}`)
  })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const promptUser = () => {
    rl.question('\n👤 You > ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === 'exit') {
        console.log('Exiting interactive session...')
        await session.close()
        process.exit(0)
      }

      try {
        console.log('Sending message to Jules...')
        const startTime = Date.now()
        let reply: string
        if (!session.julesSessionId) {
          const replyPromise = new Promise<string>((resolve) => {
            session.once('agent_reply', (data: { content: string }) => resolve(data.content))
          })
          await session.init(trimmed)
          reply = await replyPromise
        } else {
          reply = await session.sendUserMessage(trimmed)
        }

        const durationSec = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(`\n\n🐙 Jules (${durationSec}s) >\n${reply}\n`)
      } catch (err: any) {
        console.error(`\n❌ Error:`, err.message)
      }

      promptUser()
    })
  }

  promptUser()
}

async function main() {
  const options = parseArgs()

  // 1. Server mode
  if (options.server) {
    await prisma.$connect()
    startHarnessServer(options.port)
    return
  }

  // 2. Single query mode
  if (options.query) {
    try {
      if (options.url) {
        const result = await runRemoteQuery(options.url, options.query, options)
        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log(
            `\n🐙 Jules Response (via ${options.url}):\n${result.firstReply || result.reply}\n`,
          )
        }
      } else {
        const result = await runLocalQuery(options.query, options)
        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log(
            `\n\n🐙 Jules Response (${(result.latencyMs / 1000).toFixed(1)}s):\n${result.reply}\n`,
          )
          if (result.planProposed) {
            console.log(`⚠️ Note: An implementation plan was generated during this session.`)
          }
        }
      }
      process.exit(0)
    } catch (err: any) {
      if (options.json) {
        console.log(JSON.stringify({ error: err.message }))
      } else {
        console.error(`❌ Query failed:`, err.message)
      }
      process.exit(1)
    }
  }

  // 3. Interactive mode
  await startInteractiveRepl(options)
}

main().catch((err) => {
  console.error('Fatal harness error:', err)
  process.exit(1)
})
