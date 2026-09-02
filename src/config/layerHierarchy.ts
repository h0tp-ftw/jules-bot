import { deepMergeMessages } from '../strings.js'
import { yamlConfig } from './yaml.js'

export type ConfigLayer = Record<string, any>

/**
 * Merge one override layer into an accumulator. Sub-objects (access_control,
 * reactions, auto_reject, jules_reactions, nudge, pre_warmed_sessions) are
 * shallow-merged so later layers win per key, while `messages` is deep-merged.
 */
export function mergeOverrideLayer(acc: any, layer: any): any {
  if (!layer || typeof layer !== 'object') return acc
  return {
    ...acc,
    ...layer,
    access_control: { ...(acc.access_control || {}), ...(layer.access_control || {}) },
    reactions: { ...(acc.reactions || {}), ...(layer.reactions || {}) },
    auto_reject: { ...(acc.auto_reject || {}), ...(layer.auto_reject || {}) },
    jules_reactions: { ...(acc.jules_reactions || {}), ...(layer.jules_reactions || {}) },
    nudge: { ...(acc.nudge || {}), ...(layer.nudge || {}) },
    pre_warmed_sessions: {
      ...(acc.pre_warmed_sessions || {}),
      ...(layer.pre_warmed_sessions || {}),
    },
    messages: deepMergeMessages(acc.messages || {}, layer.messages || {}),
  }
}

/**
 * Extracts and returns the ordered list of configuration override layers
 * for a given Discord thread/channel and member:
 * 1. Parent Channel Override
 * 2. Forum Tag Overrides (accumulated in config order)
 * 3. Thread/Channel Override
 * 4. Member Role Overrides (accumulated in config order)
 */
export function resolveOverrideLayers(thread?: any, member?: any): {
  parentOverride: ConfigLayer
  tagOverride: ConfigLayer
  threadOverride: ConfigLayer
  roleOverride: ConfigLayer
  layers: ConfigLayer[]
} {
  const channelsConfig = yamlConfig.channels || {}

  let threadOverride: ConfigLayer = {}
  let parentOverride: ConfigLayer = {}

  if (thread) {
    if (thread.id && channelsConfig[thread.id]) {
      threadOverride = channelsConfig[thread.id]
    }
    if (thread.parentId && channelsConfig[thread.parentId]) {
      parentOverride = channelsConfig[thread.parentId]
    }
  }

  // Resolve tag-based overrides from the forum post's applied tags.
  let tagOverride: ConfigLayer = {}
  if (thread && Array.isArray(thread.appliedTags) && thread.appliedTags.length > 0) {
    const tagsConfig = yamlConfig.tags || {}
    if (Object.keys(tagsConfig).length > 0) {
      const appliedIds = new Set<string>(thread.appliedTags.map(String))
      const appliedNames = new Set<string>()
      const availableTags = thread.parent?.availableTags
      if (Array.isArray(availableTags)) {
        for (const at of availableTags) {
          if (at && appliedIds.has(String(at.id)) && typeof at.name === 'string') {
            appliedNames.add(at.name)
          }
        }
      }
      for (const [tagKey, tagVal] of Object.entries(tagsConfig)) {
        const matches = appliedIds.has(tagKey) || appliedNames.has(tagKey)
        if (matches && tagVal && typeof tagVal === 'object') {
          tagOverride = mergeOverrideLayer(tagOverride, tagVal)
        }
      }
    }
  }

  // Resolve role-based overrides if member is provided
  let roleOverride: ConfigLayer = {}
  if (member && member.roles) {
    const rolesConfig = yamlConfig.roles || {}
    for (const [roleKey, roleVal] of Object.entries(rolesConfig)) {
      let hasRole = false
      if ('cache' in member.roles) {
        hasRole =
          member.roles.cache.has(roleKey) || member.roles.cache.some((r: any) => r.name === roleKey)
      } else if (Array.isArray(member.roles)) {
        hasRole = member.roles.includes(roleKey)
      }

      if (hasRole && roleVal && typeof roleVal === 'object') {
        roleOverride = mergeOverrideLayer(roleOverride, roleVal)
      }
    }
  }

  return {
    parentOverride,
    tagOverride,
    threadOverride,
    roleOverride,
    layers: [parentOverride, tagOverride, threadOverride, roleOverride],
  }
}
