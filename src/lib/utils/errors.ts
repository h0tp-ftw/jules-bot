// Shared formatter for error text that gets shown to users inside a Discord
// fenced code block. Kept dependency-free so it can be unit-tested directly.

const ZERO_WIDTH_SPACE = '​'

/**
 * Normalizes an arbitrary thrown value into text safe to drop inside a Discord
 * ``` ``` ``` fenced code block: prefers the stack, falls back to the message,
 * then to String(err). Any run of backticks is de-fanged (a zero-width space is
 * inserted between them) so an error string containing its own ``` fence can't
 * break out of the surrounding block. The result is trimmed and length-capped
 * (with an ellipsis) so the final message stays under Discord's 2000-char limit.
 */
export function formatErrorForDiscord(err: unknown, maxLen = 1800): string {
  let text: string
  if (err instanceof Error) {
    text = err.stack || err.message
  } else if (typeof err === 'string') {
    text = err
  } else {
    text = String(err)
  }

  // Neutralize embedded backtick runs so they can't close the code fence.
  text = text.replace(/`+/g, (run) => run.split('').join(ZERO_WIDTH_SPACE))
  text = text.trim()

  if (text.length > maxLen) {
    text = text.slice(0, maxLen - 1) + '…'
  }

  return text || 'Unknown error'
}
