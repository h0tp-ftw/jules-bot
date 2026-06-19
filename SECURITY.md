# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately via
[GitHub Security Advisories](https://github.com/h0tp-ftw/jules-bot/security/advisories/new)
(Security → Report a vulnerability). We'll aim to acknowledge within a few days and
coordinate a fix and disclosure.

## Secrets & handling

- `DISCORD_TOKEN` and `JULES_API_KEY` are secrets. They belong only in `.env` (gitignored)
  or your process environment — never commit them. The same goes for your runtime
  `config.yaml`, `AGENTS.md`, and `SOUL.md`.
- If a token is ever exposed, **rotate it immediately** (Discord Developer Portal / Jules)
  and scrub it from git history.
- Back up `prisma/dev.db` (the thread⇄session map) somewhere private — it can reveal repo
  and channel identifiers.

## Access control

Bot actions are gated by the `access_control` allowlist (`allow_all`, `allowed_users`,
`allowed_roles`), enforced on commands, thread messages, and component interactions. See
the README's **Security & Access Control** section. Run the bot as a **single instance per
token** and keep its host patched.

## Supported versions

This is an actively developed project; fixes land on `main`. Please test against the latest
`main` before reporting.
