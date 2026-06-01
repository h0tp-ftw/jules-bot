import { ThreadChannel, Events } from 'discord.js'
import { prisma, YAML_GUILDS, getEffectiveConfig } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'
import { replenishPool } from '../lib/jules/PreWarmedManager.js'

export default {
  name: Events.ThreadCreate,
  async execute(thread: ThreadChannel, streamManager: StreamManager) {
    if (!thread.guildId) return

    // Check config.yaml overrides first
    const yamlGuild = YAML_GUILDS[thread.guildId]
    let repo = yamlGuild?.default_repo
    let forumChannelId = yamlGuild?.forum_channel_id

    // Fallback to database config if not configured in YAML
    if (!repo || !forumChannelId) {
      const config = await prisma.guildConfig.findUnique({
        where: { guildId: thread.guildId },
      })
      if (!repo) repo = config?.defaultRepo ?? undefined
      if (!forumChannelId) forumChannelId = config?.forumChannelId ?? undefined
    }

    if (!forumChannelId || thread.parentId !== forumChannelId) {
      // Thread is not in the designated debugging forum channel
      return
    }

    // Wait a brief moment to ensure the starter message is posted
    await new Promise((resolve) => setTimeout(resolve, 2000))

    let starterMessage = null
    try {
      starterMessage = await thread.fetchStarterMessage()
    } catch (err) {
      console.error('Failed to fetch starter message:', err)
    }

    if (!starterMessage || !starterMessage.content) {
      await thread.send('⚠️ **Could not retrieve the starter message for this thread. Please reply with your issue details to start.**')
      return
    }

    if (!repo) {
      await thread.send('⚠️ **No default repository has been set for this server.** Please use the `/link-repo` command to set a default repository.')
      return
    }

    const repoName: string = repo

    await thread.send(`🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\``)

      try {
        const authorNickname = starterMessage.member?.displayName || starterMessage.author.username
        const messageTime = starterMessage.createdAt.toISOString()
        const threadTitle = thread.name
        
        let promptWithMetadata = `[Message details - Author Nickname: ${authorNickname}, Message Time: ${messageTime}, Issue/Thread Title: ${threadTitle}]\n\n${starterMessage.content}`

        let session: any = null
        let usedPreWarmed = false
        let initialSkipIds: Set<string> | undefined

        const threadConfig = getEffectiveConfig(thread)
        if (threadConfig.pre_warmed_sessions.enabled) {
          let preWarmed = await prisma.preWarmedSession.findFirst({
            where: { repoName, ready: true },
            orderBy: { createdAt: 'asc' },
          })

          if (!preWarmed) {
            const warming = await prisma.preWarmedSession.findFirst({
              where: { repoName, ready: false },
              orderBy: { createdAt: 'asc' },
            })
            if (warming) {
              const statusMsg = await thread.send('⏳ **A session is currently pre-warming. Waiting for it to become ready...**')
              for (let attempt = 0; attempt < 12; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 5000))
                const check = await prisma.preWarmedSession.findUnique({
                  where: { id: warming.id }
                })
                if (check && check.ready) {
                  preWarmed = check
                  break
                }
              }
              await statusMsg.delete().catch(() => {})
            }
          }

          if (preWarmed) {
            try {
              session = JulesClient.getSession(preWarmed.id)
              
              // Fetch current activity IDs to skip them in the stream
              const info = await session.info()
              if (info.activities) {
                initialSkipIds = new Set(info.activities.map((a: any) => a.id))
              }

              if (info.state === 'awaitingPlanApproval') {
                console.log(`[threadCreate] Automatically approving welcome plan for pre-warmed session ${session.id}`)
                await session.approve()
              }

              await prisma.preWarmedSession.delete({
                where: { id: preWarmed.id },
              })
              usedPreWarmed = true
              console.log(`[threadCreate] Consumed pre-warmed session ${session.id} for repo ${repoName}`)
            } catch (err) {
              console.error(`[threadCreate] Failed to rehydrate pre-warmed session ${preWarmed.id}:`, err)
            }
          }
        }

      if (!session) {
        session = await JulesClient.createSession({
          prompt: promptWithMetadata,
          repo: repoName,
          title: thread.name,
          thread: thread,
        })
      }

      await prisma.debugSession.create({
        data: {
          threadId: thread.id,
          guildId: thread.guildId,
          julesSessionId: session.id,
          repoName: repoName,
        },
      })

      // Start processing events in the background
      runJulesStream(session.id, thread, streamManager, initialSkipIds)

      if (usedPreWarmed) {
        // Inform user we are using a ready session and start typing immediately
        await thread.send('🚀 **Ready session found! Processing your issue...**')
        thread.sendTyping().catch(() => {})
        
        await session.send(promptWithMetadata)
        replenishPool(repoName).catch(() => {})
      } else if (threadConfig.pre_warmed_sessions.enabled) {
        replenishPool(repoName).catch(() => {})
      }
    } catch (err) {
      console.error('Failed to start Jules session:', err)
      await thread.send('❌ **Failed to start Jules diagnostic session. Please verify your repository configuration and permissions.**')
    }
  },
}
