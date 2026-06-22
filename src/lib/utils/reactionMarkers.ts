// Parses Jules-authored reaction markers out of an agent message.
//
// Jules can only emit text (no tools / MCP), so to let it react to a Discord
// message we define a tiny inline protocol: it writes `[[react:👍]]` (one emoji
// per marker, repeatable) anywhere in its reply. The orchestrator extracts those
// markers, reacts on the user's message with each emoji, and strips the markers
// from the text before posting so they never render literally.
//
// The emoji payload may be a Unicode emoji, a full custom-emoji tag
// (`<:name:id>` / `<a:name:id>`), a `name:id` pair, a `:shortcode:`, or a raw id.
// Resolution to a react()-compatible form happens at the call site (it needs the
// Discord client's emoji cache); this module stays pure and client-free so it is
// trivially unit-testable.

// Match `[[react: EMOJI ]]` — case-insensitive, tolerant of surrounding spaces.
// A leading run of horizontal whitespace is consumed so removing an inline marker
// doesn't leave a double space behind. `[^\]]+?` keeps the payload on one marker
// (custom tags contain no `]`), so adjacent markers never merge.
const REACTION_MARKER = /[ \t]*\[\[\s*react\s*:\s*([^\]]+?)\s*\]\]/gi

export interface ExtractedReactions {
  /** The message text with every reaction marker removed and tidied. */
  text: string
  /** The raw emoji payloads, in order, one per marker. */
  emojis: string[]
}

/**
 * Splits reaction markers out of an agent message. Returns the cleaned display
 * text alongside the ordered list of emoji payloads. Horizontal whitespace
 * (indentation, code blocks) is preserved; only the markers themselves and any
 * blank gap they leave behind are collapsed.
 */
export function extractReactionMarkers(input: string): ExtractedReactions {
  if (!input) return { text: input, emojis: [] }

  const emojis: string[] = []
  const stripped = input.replace(REACTION_MARKER, (_match, emoji) => {
    const trimmed = String(emoji).trim()
    if (trimmed) emojis.push(trimmed)
    return ''
  })

  if (emojis.length === 0) return { text: input, emojis }

  // A marker sitting on its own line leaves a blank line behind; collapse runs of
  // 3+ newlines back to a paragraph break, then trim the ends. Don't touch
  // horizontal whitespace so the agent's intentional formatting survives.
  const text = stripped.replace(/\n{3,}/g, '\n\n').trim()
  return { text, emojis }
}
