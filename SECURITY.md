# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/h0tp-ftw/jules-bot/security/advisories/new)
(the **Security** tab → **Report a vulnerability**). We aim to acknowledge
reports within a few days and will coordinate a fix and disclosure with you.

## Scope & handling secrets

This bot holds two sensitive credentials, both supplied via the gitignored
`.env` file and **never** committed:

- `DISCORD_TOKEN`
- `JULES_API_KEY`

`config.yaml`, `AGENTS.md`, and `SOUL.md` are also gitignored runtime config.
When sharing logs or config in an issue/PR, **redact bot tokens, API keys, and
private Discord IDs** first.

If you believe a token has been exposed, rotate it immediately:

- Discord: regenerate the token in the Developer Portal.
- Jules: revoke and reissue the API key.
