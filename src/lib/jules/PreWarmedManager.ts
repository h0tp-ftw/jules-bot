import { jules } from '@google/jules-sdk'
import { prisma, YAML_GUILDS, PRE_WARMED_SESSIONS, JULES_API_KEY, DIAGNOSTIC_PROMPT, AGENT_PERSONALITY, SOUL_PERSONALITY, getBootstrapContext } from '../../config.js'

const client = JULES_API_KEY ? jules.with({ apiKey: JULES_API_KEY }) : jules

export async function preWarmSession(repoName: string) {
  try {
    let defaultPrompt = `${DIAGNOSTIC_PROMPT}\n\nAgent Personality and Guidelines:\n${AGENT_PERSONALITY}\n\nAgent Soul and Principles:\n${SOUL_PERSONALITY}`
    const bootstrapContext = getBootstrapContext()
    if (bootstrapContext) {
      defaultPrompt += `\n\nBootstrap Knowledge and Context:\n${bootstrapContext}`
    }

    const preWarmingPrompt = PRE_WARMED_SESSIONS.pre_warming_prompt || 
      `You are a diagnostic assistant. The user is currently connecting. You may send a brief friendly greeting or joke to welcome the user. Do NOT generate any code modifications yet. Wait for the user's issue details in the next message, then analyze the codebase and propose a plan.`

    defaultPrompt += `\n\nSystem Directive:\n${preWarmingPrompt}`

    console.log(`[Pre-warm] Creating session for ${repoName}...`)
    const session = await client.session({
      prompt: defaultPrompt,
      source: { github: repoName, baseBranch: 'main' },
      title: `Pre-warmed Session (${repoName})`,
      requireApproval: true,
    })

    // Store in DB immediately
    await prisma.preWarmedSession.create({
      data: {
        id: session.id,
        repoName,
      }
    })

    console.log(`[Pre-warm] Created session ${session.id} for ${repoName}. Waiting for ready...`)

    // Wait until it's out of queued state, and if it proposes an initial plan, approve it
    let info = await session.info()
    while (info && info.state === 'queued') {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      info = await session.info()
    }

    // Mark as ready in DB
    await prisma.preWarmedSession.update({
      where: { id: session.id },
      data: { 
        ready: true,
        welcomeMessage: null
      }
    })

    console.log(`[Pre-warm] Session ${session.id} is now fully warm and ready in awaitingPlanApproval state.`)
  } catch (err) {
    console.error(`[Pre-warm] Failed to pre-warm session for ${repoName}:`, err)
  }
}

export async function replenishPool(repoName: string) {
  if (!PRE_WARMED_SESSIONS.enabled) return
  
  // Count how many pre-warmed sessions exist for this repo (including those warming)
  const count = await prisma.preWarmedSession.count({
    where: { repoName }
  })
  
  const targetCount = PRE_WARMED_SESSIONS.pool_size
  if (count < targetCount) {
    const needed = targetCount - count
    console.log(`[Pool] Replenishing pre-warmed pool for ${repoName}. Current: ${count}, Target: ${targetCount}. Spawning ${needed} session(s) in background.`)
    for (let i = 0; i < needed; i++) {
      preWarmSession(repoName).catch(() => {})
    }
  }
}

export async function initPreWarmedPools() {
  if (!PRE_WARMED_SESSIONS.enabled) return

  console.log('[Pool] Initializing pre-warmed session pools...')

  // Cleanup any sessions that didn't finish warming from a previous run
  try {
    const deleted = await prisma.preWarmedSession.deleteMany({
      where: { ready: false }
    })
    if (deleted.count > 0) {
      console.log(`[Pool] Cleaned up ${deleted.count} stale pre-warmed sessions.`)
    }
  } catch (err) {
    console.error('[Pool] Failed to cleanup stale sessions:', err)
  }

  const repos = new Set<string>()

  // 1. Get repos from YAML
  for (const guildConf of Object.values(YAML_GUILDS)) {
    if (guildConf.default_repo) {
      repos.add(guildConf.default_repo)
    }
  }

  // 2. Get repos from Database
  try {
    const dbConfigs = await prisma.guildConfig.findMany()
    for (const conf of dbConfigs) {
      if (conf.defaultRepo) {
        repos.add(conf.defaultRepo)
      }
    }
  } catch (err) {
    console.error('[Pool] Failed to fetch guild configs from database on startup:', err)
  }

  // 3. Replenish for each repo
  for (const repo of repos) {
    replenishPool(repo).catch(() => {})
  }
}
