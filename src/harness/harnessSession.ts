import EventEmitter from 'node:events'
import { prisma, getEffectiveConfig } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream, wakeJulesStream, scheduleJulesRequest } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'
import { buildReplyAwarePrompt } from '../lib/utils/reply.js'
import {
  enqueueConversationMessage,
  markConversationTurnDispatched,
  type ConversationTurn,
} from '../lib/jules/ConversationQueue.js'
import { VirtualDiscordChannel, VirtualDiscordMessage } from './virtualChannel.js'
import type { JulesDiscordChannel } from '../lib/jules/channelTypes.js'
import { logger } from '../lib/utils/logger.js'

export interface HarnessSessionOptions {
  sessionId?: string
  repo?: string
  branch?: string
  channelId?: string
  channelName?: string
  guildId?: string
  parentId?: string
  appliedTags?: string[]
  mode?: 'chatbot' | 'forum'
  authorName?: string
  authorId?: string
  initialPrompt?: string
}

export interface HarnessEvent {
  type:
    | 'progress'
    | 'plan_proposed'
    | 'plan_auto_rejected'
    | 'agent_reply'
    | 'reaction'
    | 'status_edit'
    | 'error'
  data: any
  timestamp: number
}

export class HarnessSession extends EventEmitter {
  public id: string
  public virtualChannel: VirtualDiscordChannel
  public julesSessionId?: string
  public repo: string
  public branch: string
  public mode: 'chatbot' | 'forum'
  public authorName: string
  public authorId: string
  public streamManager: StreamManager
  public events: HarnessEvent[] = []
  private julesSession: any = null
  private closed = false
  private activeTurnPromise: {
    resolve: (reply: string) => void
    reject: (err: any) => void
  } | null = null

  constructor(options: HarnessSessionOptions = {}) {
    super()
    this.id = options.sessionId || `harness-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const simulatedChannelId =
      options.channelId ||
      (options.mode === 'forum' ? '1511268531369545869' : '1382329537676705792')
    this.virtualChannel = new VirtualDiscordChannel({
      id: simulatedChannelId,
      name:
        options.channelName || (options.mode === 'forum' ? 'test-forum-thread' : 'general-chat'),
      guildId: options.guildId || '1241773562629718148',
      parentId: options.parentId,
      appliedTags: options.appliedTags,
      isThread: options.mode === 'forum',
    })

    const channelConfig = getEffectiveConfig(this.virtualChannel)
    this.repo = options.repo || channelConfig.default_repo || 'h0tp-ftw/ankimon'
    this.branch = options.branch || channelConfig.default_branch || 'main'
    this.mode = options.mode || 'chatbot'
    this.authorName = options.authorName || 'Tester'
    this.authorId = options.authorId || '445586026451173377'

    this.streamManager = new StreamManager(this.virtualChannel.client)
    this.setupChannelListeners()
  }

  private setupChannelListeners() {
    this.virtualChannel.on('message', (msg: VirtualDiscordMessage) => {
      if (msg.author.bot) {
        // If it's a bot message
        if (msg.embeds && msg.embeds.length > 0) {
          const isPlan = msg.embeds.some((e: any) => e.data?.title?.includes('Plan'))
          if (isPlan) {
            this.recordEvent('plan_proposed', { embeds: msg.embeds, components: msg.components })
            return
          }
        }

        if (msg.content) {
          if (msg.content.includes('Plan feedback sent')) {
            this.recordEvent('plan_auto_rejected', { content: msg.content })
          } else {
            this.recordEvent('agent_reply', { content: msg.content, messageId: msg.id })
            if (this.activeTurnPromise) {
              this.activeTurnPromise.resolve(msg.content)
              this.activeTurnPromise = null
            }
          }
        }
      }
    })

    this.virtualChannel.on('reaction', (record: { messageId: string; emoji: string }) => {
      this.recordEvent('reaction', record)
    })

    this.virtualChannel.on('messageEdit', (record: { message: VirtualDiscordMessage }) => {
      this.recordEvent('status_edit', { content: record.message.content })
    })
  }

  private recordEvent(type: HarnessEvent['type'], data: any) {
    const evt: HarnessEvent = { type, data, timestamp: Date.now() }
    this.events.push(evt)
    this.emit(type, data)
    this.emit('event', evt)
  }

  async init(initialPrompt?: string): Promise<string> {
    const isChatbot = this.mode === 'chatbot'
    const starterPrompt = initialPrompt || 'Hello, I am testing the bot interaction.'

    // 1. Post simulated user message in channel
    const starterMessage = await this.virtualChannel._addMessage({
      content: starterPrompt,
      authorId: this.authorId,
      authorUsername: this.authorName,
      authorDisplayName: this.authorName,
      isBot: false,
    })

    const channelConfig = getEffectiveConfig(this.virtualChannel, starterMessage.member, this.repo)

    // 2. Format with reply aware prompt metadata
    const template = isChatbot
      ? channelConfig.messages.prompts.metadata_header_with_channel
      : channelConfig.messages.prompts.metadata_header_with_title

    const vars: Record<string, string> = {
      nickname: this.authorName,
      username: this.authorName,
      id: this.authorId,
      message_id: starterMessage.id,
      time: starterMessage.createdAt.toISOString(),
      content: starterPrompt,
    }
    if (isChatbot) {
      vars.channel = this.virtualChannel.name
    } else {
      vars.title = this.virtualChannel.name
    }

    const promptWithMetadata = await buildReplyAwarePrompt(
      starterMessage as any,
      channelConfig.reply_context_mode,
      template,
      vars,
      channelConfig.messages.prompts,
    )

    logger.info(
      `[Harness] Initializing session with repo=${this.repo}, branch=${this.branch}, mode=${this.mode}`,
    )

    // 3. Create Jules session
    this.julesSession = await scheduleJulesRequest(() =>
      JulesClient.createSession({
        prompt: promptWithMetadata,
        repo: this.repo,
        branch: this.branch,
        title: this.virtualChannel.name,
        thread: this.virtualChannel,
        member: starterMessage.member,
      }),
    )

    this.julesSessionId = this.julesSession.id
    logger.info(`[Harness] Created Jules session: ${this.julesSessionId}`)

    // 4. Save to SQLite DebugSession
    await prisma.debugSession.upsert({
      where: { threadId: this.virtualChannel.id },
      create: {
        threadId: this.virtualChannel.id,
        guildId: this.virtualChannel.guildId,
        julesSessionId: this.julesSession.id,
        repoName: this.repo,
        deliveryCursorInitialized: true,
      },
      update: {
        julesSessionId: this.julesSession.id,
        repoName: this.repo,
        statusMessageId: null,
        planMessageId: null,
      },
    })

    // 5. Start runJulesStream
    void runJulesStream(
      this.julesSession.id,
      this.virtualChannel as unknown as JulesDiscordChannel,
      this.streamManager,
      undefined,
      undefined,
      { chatbotMode: isChatbot },
    ).catch((err) => {
      logger.error(`[Harness] Stream error for session ${this.julesSessionId}:`, err)
      this.recordEvent('error', { error: String(err) })
    })

    return this.julesSession.id
  }

  async sendUserMessage(content: string, timeoutMs = 120000): Promise<string> {
    if (!this.julesSession) {
      throw new Error('Harness session has not been initialized. Call init() first.')
    }

    const userMessage = await this.virtualChannel._addMessage({
      content,
      authorId: this.authorId,
      authorUsername: this.authorName,
      authorDisplayName: this.authorName,
      isBot: false,
    })

    const channelConfig = getEffectiveConfig(this.virtualChannel, userMessage.member, this.repo)
    const promptWithMetadata = await buildReplyAwarePrompt(
      userMessage as any,
      channelConfig.reply_context_mode,
      channelConfig.messages.prompts.metadata_header,
      {
        nickname: this.authorName,
        username: this.authorName,
        id: this.authorId,
        message_id: userMessage.id,
        time: userMessage.createdAt.toISOString(),
        content,
      },
      channelConfig.messages.prompts,
    )

    const turnPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.activeTurnPromise?.resolve === resolve) {
          this.activeTurnPromise = null
          reject(new Error(`Timeout waiting for agent reply after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      this.activeTurnPromise = {
        resolve: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }
    })

    await enqueueConversationMessage(
      this.virtualChannel.id,
      userMessage as any,
      async (turn: ConversationTurn) => {
        markConversationTurnDispatched(this.virtualChannel.id, turn.id)
        await scheduleJulesRequest(() => this.julesSession.send(promptWithMetadata))
        wakeJulesStream(this.virtualChannel.id)
        return true
      },
    )

    return await turnPromise
  }

  async approvePlan(): Promise<void> {
    if (!this.julesSession) throw new Error('Session not initialized')
    logger.info(`[Harness] Approving plan for session ${this.julesSessionId}`)
    await scheduleJulesRequest(() => this.julesSession.approve())
    wakeJulesStream(this.virtualChannel.id)
  }

  async rejectPlan(feedback?: string): Promise<void> {
    if (!this.julesSession) throw new Error('Session not initialized')
    const threadConfig = getEffectiveConfig(this.virtualChannel)
    const msg = feedback || threadConfig.messages.prompts.auto_reject_default
    logger.info(`[Harness] Rejecting plan for session ${this.julesSessionId} with feedback: ${msg}`)
    await scheduleJulesRequest(() => this.julesSession.send(msg))
    wakeJulesStream(this.virtualChannel.id)
  }

  getTranscript(): {
    messages: { id: string; author: string; isBot: boolean; content: string; createdAt: Date }[]
    events: HarnessEvent[]
  } {
    return {
      messages: this.virtualChannel.getAllMessages().map((m) => ({
        id: m.id,
        author: m.author.username,
        isBot: m.author.bot,
        content: m.content,
        createdAt: m.createdAt,
      })),
      events: [...this.events],
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await prisma.debugSession.deleteMany({
        where: { threadId: this.virtualChannel.id },
      })
    } catch {
      // Ignore DB cleanup error
    }
  }
}
