import EventEmitter from 'node:events'
import { Collection, type ChannelType } from 'discord.js'

export interface VirtualMessagePayload {
  content?: string
  embeds?: any[]
  components?: any[]
  allowedMentions?: any
}

export interface VirtualAttachment {
  name: string
  url: string
  contentType?: string
  size?: number
}

export interface VirtualReactionRecord {
  emoji: string
  timestamp: number
}

export class VirtualDiscordMessage {
  public id: string
  public channelId: string
  public channel: VirtualDiscordChannel
  public client: any
  public author: { id: string; username: string; bot: boolean }
  public member: { displayName: string; roles: { cache: Map<string, any> } } | undefined
  public content: string
  public embeds: any[]
  public components: any[]
  public attachments: Collection<string, VirtualAttachment>
  public createdAt: Date
  public createdTimestamp: number
  public reference: { messageId?: string } | null
  public reactions: { cache: Collection<string, any> }
  public reactionsApplied: string[] = []

  constructor(options: {
    id: string
    channel: VirtualDiscordChannel
    authorId?: string
    authorUsername?: string
    authorDisplayName?: string
    roles?: string[]
    content?: string
    embeds?: any[]
    components?: any[]
    attachments?: VirtualAttachment[]
    referenceMessageId?: string
    isBot?: boolean
  }) {
    this.id = options.id
    this.channel = options.channel
    this.channelId = options.channel.id
    this.client = options.channel.client
    this.content = options.content || ''
    this.embeds = options.embeds || []
    this.components = options.components || []
    this.createdAt = new Date()
    this.createdTimestamp = this.createdAt.getTime()
    this.reference = options.referenceMessageId ? { messageId: options.referenceMessageId } : null

    const roleMap = new Map<string, any>()
    for (const r of options.roles || []) {
      roleMap.set(r, { id: r, name: r })
    }

    this.author = {
      id: options.authorId || '445586026451173377',
      username: options.authorUsername || 'Tester',
      bot: options.isBot ?? false,
    }

    this.member = {
      displayName: options.authorDisplayName || options.authorUsername || 'Tester',
      roles: { cache: roleMap },
    }

    this.attachments = new Collection<string, VirtualAttachment>()
    if (options.attachments) {
      for (const att of options.attachments) {
        this.attachments.set(att.name, att)
      }
    }

    this.reactions = {
      cache: new Collection<string, any>(),
    }
  }

  async reply(payload: string | VirtualMessagePayload): Promise<VirtualDiscordMessage> {
    const norm = typeof payload === 'string' ? { content: payload } : payload
    return await this.channel._addMessage({
      ...norm,
      referenceMessageId: this.id,
      isBot: true,
      authorId: this.client.user?.id || 'bot-virtual',
      authorUsername: 'JulesBot',
    })
  }

  async react(emoji: string): Promise<void> {
    this.reactionsApplied.push(emoji)
    this.channel.emit('reaction', { messageId: this.id, emoji })
  }

  async edit(payload: string | VirtualMessagePayload): Promise<VirtualDiscordMessage> {
    const norm = typeof payload === 'string' ? { content: payload } : payload
    if (norm.content !== undefined) this.content = norm.content
    if (norm.embeds !== undefined) this.embeds = norm.embeds
    if (norm.components !== undefined) this.components = norm.components

    this.channel.emit('messageEdit', { message: this })
    return this
  }
}

export class VirtualDiscordChannel extends EventEmitter {
  public id: string
  public name: string
  public guildId: string
  public parentId?: string
  public appliedTags: string[]
  public client: any
  public archived: boolean = false
  public locked: boolean = false
  public channelType: ChannelType | number
  public isThreadChannel: boolean
  private messageMap = new Map<string, VirtualDiscordMessage>()
  private messageCounter = 0

  constructor(options: {
    id: string
    name?: string
    guildId?: string
    parentId?: string
    appliedTags?: string[]
    isThread?: boolean
    channelType?: ChannelType | number
    client?: any
  }) {
    super()
    this.id = options.id
    this.name = options.name || 'test-channel'
    this.guildId = options.guildId || '1241773562629718148'
    this.parentId = options.parentId
    this.appliedTags = options.appliedTags || []
    this.isThreadChannel = options.isThread ?? false
    this.channelType = options.channelType ?? (this.isThreadChannel ? 11 : 0) // 11 = PublicThread, 0 = GuildText

    this.client = options.client || {
      user: { id: '1382329537676705790', tag: 'JulesBot#0000' },
      channels: {
        fetch: async (id: string) => (id === this.id ? this : null),
      },
      emojis: {
        cache: {
          get: () => undefined,
        },
      },
    }
  }

  isThread(): boolean {
    return this.isThreadChannel
  }

  get messages() {
    return {
      fetch: async (arg?: string | { limit?: number }) => {
        if (typeof arg === 'string') {
          const found = this.messageMap.get(arg)
          if (!found) throw new Error(`Message ${arg} not found`)
          return found
        }
        // Return collection
        const col = new Collection<string, VirtualDiscordMessage>()
        for (const [id, msg] of this.messageMap.entries()) {
          col.set(id, msg)
        }
        return col
      },
    }
  }

  async fetchStarterMessage(): Promise<VirtualDiscordMessage | null> {
    for (const msg of this.messageMap.values()) {
      if (!msg.author.bot) {
        return msg
      }
    }
    return null
  }

  async sendTyping(): Promise<void> {
    this.emit('typing', { channelId: this.id, timestamp: Date.now() })
  }

  async send(payload: string | VirtualMessagePayload): Promise<VirtualDiscordMessage> {
    const norm = typeof payload === 'string' ? { content: payload } : payload
    return await this._addMessage({
      ...norm,
      isBot: true,
      authorId: this.client.user?.id || 'bot-virtual',
      authorUsername: 'JulesBot',
    })
  }

  async _addMessage(options: {
    content?: string
    embeds?: any[]
    components?: any[]
    attachments?: VirtualAttachment[]
    referenceMessageId?: string
    isBot?: boolean
    authorId?: string
    authorUsername?: string
    authorDisplayName?: string
    roles?: string[]
  }): Promise<VirtualDiscordMessage> {
    const msgId = `vmsg-${this.id}-${++this.messageCounter}`
    const msg = new VirtualDiscordMessage({
      id: msgId,
      channel: this,
      ...options,
    })
    this.messageMap.set(msgId, msg)
    this.emit('message', msg)
    return msg
  }

  getAllMessages(): VirtualDiscordMessage[] {
    return Array.from(this.messageMap.values())
  }

  getBotMessages(): VirtualDiscordMessage[] {
    return Array.from(this.messageMap.values()).filter((m) => m.author.bot)
  }

  getLastBotMessage(): VirtualDiscordMessage | undefined {
    const botMsgs = this.getBotMessages()
    return botMsgs[botMsgs.length - 1]
  }
}
