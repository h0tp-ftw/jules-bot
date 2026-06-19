export function splitMessage(text: string, limit: number = 2000): string[] {
  if (text.length <= limit) return [text]
  const result: string[] = []
  let current = text
  while (current.length > limit) {
    let splitIndex = current.lastIndexOf('\n', limit)
    // Fall back to a hard split when there's no newline within the limit, or the
    // only one is at the very start (which would otherwise push an empty chunk
    // and stall progress).
    if (splitIndex <= 0) splitIndex = limit
    const chunk = current.slice(0, splitIndex)
    if (chunk) result.push(chunk)
    current = current.slice(splitIndex).trimStart()
  }
  if (current) result.push(current)
  return result
}
