// OAuth2 invite-link helper shared by the setup wizard (and unit-tested in
// test/invite.test.ts). Kept dependency-free so it can run before `npm install`.

// Permissions the bot needs (see README → Discord Developer Portal), as a BigInt
// bitfield for the OAuth2 invite URL.
export const INVITE_PERMISSIONS = [
  1n << 6n, // Add Reactions
  1n << 10n, // View Channels
  1n << 11n, // Send Messages
  1n << 13n, // Manage Messages
  1n << 14n, // Embed Links
  1n << 16n, // Read Message History
  1n << 31n, // Use Application Commands
  1n << 38n, // Send Messages in Threads
].reduce((acc, bit) => acc | bit, 0n)

export function inviteUrl(clientId) {
  const params = new URLSearchParams({
    client_id: clientId,
    permissions: INVITE_PERMISSIONS.toString(),
    scope: 'bot applications.commands',
  })
  return `https://discord.com/oauth2/authorize?${params.toString()}`
}
