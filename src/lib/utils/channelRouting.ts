export function isConfiguredThreadParent(
  parentId: string | null | undefined,
  forumChannelId: string | null | undefined,
  channelsConfig: Record<string, unknown> | null | undefined,
): boolean {
  if (!parentId) return false
  if (parentId === forumChannelId) return true
  return Boolean(channelsConfig && Object.prototype.hasOwnProperty.call(channelsConfig, parentId))
}
