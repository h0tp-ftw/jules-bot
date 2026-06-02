import { jules } from '@google/jules-sdk'
import { prisma, YAML_GUILDS, PRE_WARMED_SESSIONS, JULES_API_KEY, DIAGNOSTIC_PROMPT, AGENT_PERSONALITY, SOUL_PERSONALITY, getBootstrapContext, yamlConfig, getEffectiveConfig } from '../../config.js'

const client = JULES_API_KEY 
  ? jules.with({ apiKey: JULES_API_KEY, config: { requestTimeoutMs: 180000 } }) 
  : jules.with({ config: { requestTimeoutMs: 180000 } })

function getConfigForContext(contextKey: string | null) {
  if (!contextKey) return getEffectiveConfig()
  
  // If contextKey is a channel ID (numeric)
  if (/^\d+$/.test(contextKey)) {
    return getEffectiveConfig({ id: contextKey, parentId: contextKey })
  }
  
  // Else treat contextKey as a role name/ID
  const mockMember = {
    roles: {
      cache: {
        has: (key: string) => key === contextKey,
        some: (fn: any) => fn({ name: contextKey, id: contextKey })
      }
    }
  }
  return getEffectiveConfig(null, mockMember)
}

export async function preWarmSession(repoName: string, contextKey: string | null = null) {
  try {
    const config = getConfigForContext(contextKey)
    let defaultPrompt = `${config.diagnostic_prompt}\n\nAgent Personality and Guidelines:\n${config.agents_personality}\n\nAgent Soul and Principles:\n${config.soul_personality}`
    const bootstrapContext = getBootstrapContext()
    if (bootstrapContext) {
      defaultPrompt += `\n\nBootstrap Knowledge and Context:\n${bootstrapContext}`
    }

    const preWarmingPrompt = config.pre_warmed_sessions.pre_warming_prompt || 
      `You are a diagnostic assistant. The user is connecting and has just sent their initial response. Acknowledge that you are showing this message now that they have replied. Share a random cool Pokémon fact, and let them know you are actively analyzing the codebase and working on their query right now. Do NOT propose code changes yet; generate the initial plan to welcome them and begin investigation.`

    defaultPrompt += `\n\nSystem Directive:\n${preWarmingPrompt}`

    console.log(`[Pre-warm] Creating session for ${repoName} (Context: ${contextKey || 'global'})...`)
    const session = await client.session({
      prompt: defaultPrompt,
      source: { github: repoName, baseBranch: 'main' },
      title: contextKey ? `Pre-warmed Session (${repoName} - Context: ${contextKey})` : `Pre-warmed Session (${repoName})`,
      requireApproval: true,
    })

    // Store in DB immediately
    await prisma.preWarmedSession.create({
      data: {
        id: session.id,
        repoName,
        contextKey,
      }
    })

    console.log(`[Pre-warm] Created session ${session.id} for ${repoName} (Context: ${contextKey || 'global'}). Waiting for ready...`)

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
    console.error(`[Pre-warm] Failed to pre-warm session for ${repoName} (Context: ${contextKey || 'global'}):`, err)
  }
}

export async function replenishPool(repoName: string, contextKey: string | null = null) {
  const config = getConfigForContext(contextKey)
  if (!config.pre_warmed_sessions.enabled) return
  
  // Count how many pre-warmed sessions exist for this repo and context (including those warming)
  const count = await prisma.preWarmedSession.count({
    where: { repoName, contextKey }
  })
  
  const targetCount = config.pre_warmed_sessions.pool_size
  if (count < targetCount) {
    const needed = targetCount - count
    console.log(`[Pool] Replenishing pre-warmed pool for ${repoName} (Context: ${contextKey || 'global'}). Current: ${count}, Target: ${targetCount}. Spawning ${needed} session(s) in background.`)
    for (let i = 0; i < needed; i++) {
      preWarmSession(repoName, contextKey).catch(() => {})
    }
  }
}

export async function initPreWarmedPools() {
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

  // Collect contexts to warm
  const contexts: (string | null)[] = [null] // null = global default

  const channelsConfig = yamlConfig.channels || {}
  for (const channelId of Object.keys(channelsConfig)) {
    const conf = getEffectiveConfig({ id: channelId, parentId: channelId })
    if (conf.pre_warmed_sessions.enabled) {
      contexts.push(channelId)
    }
  }

  const rolesConfig = yamlConfig.roles || {}
  for (const roleKey of Object.keys(rolesConfig)) {
    const mockMember = {
      roles: {
        cache: {
          has: (key: string) => key === roleKey,
          some: (fn: any) => fn({ name: roleKey, id: roleKey })
        }
      }
    }
    const conf = getEffectiveConfig(null, mockMember)
    if (conf.pre_warmed_sessions.enabled) {
      contexts.push(roleKey)
    }
  }

  // 3. Replenish for each repo and context
  for (const repo of repos) {
    for (const contextKey of contexts) {
      replenishPool(repo, contextKey).catch(() => {})
    }
  }
}
