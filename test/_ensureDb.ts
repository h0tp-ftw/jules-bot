import fs from 'node:fs'
import path from 'node:path'

// Importing src/config.js constructs the Prisma client and, if the SQLite file
// is absent, shells out to `prisma migrate deploy` to provision it. The
// config/permissions suites only need getEffectiveConfig — they never touch the
// DB — so pre-create an empty SQLite file (a zero-byte file is a valid empty
// database) to skip that boot-time provisioning. Import this BEFORE config.js;
// ES modules evaluate imports in source order, so this runs first.
//
// Resolve the path exactly as config.ts does (from DATABASE_URL, defaulting to
// the repo's dev.db) so it lines up under CI's explicit DATABASE_URL too.
const url = process.env.DATABASE_URL || 'file:./prisma/dev.db'
if (url.startsWith('file:')) {
  const dbPath = path.resolve(url.slice(5))
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    fs.writeFileSync(dbPath, '')
  }
}
