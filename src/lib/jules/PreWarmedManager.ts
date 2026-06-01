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
    defaultPrompt += `\n\nSystem Directive:\nYou are a diagnostic assistant. The user is currently connecting. Do NOT generate any code modifications yet. Wait for the user's issue details in the next message, then analyze the codebase and propose a plan.`

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

    if (info && info.state === 'awaitingPlanApproval') {
      console.log(`[Pre-warm] Approving initial setup plan for ${session.id}...`)
      await session.approve()
    }
    
    console.log(`[Pre-warm] Session ${session.id} is now fully warm and ready.`)
  } catch (err) {
    console.error(`[Pre-warm] Failed to pre-warm session for ${repoName}:`, err)
  }
}

export async function replenishPool(repoName: string) {
  if (!PRE_WARMED_SESSIONS.enabled) return
  
  // Count how many pre-warmed sessions exist for this repo
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
