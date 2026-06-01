-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PreWarmedSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoName" TEXT NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_PreWarmedSession" ("createdAt", "id", "repoName") SELECT "createdAt", "id", "repoName" FROM "PreWarmedSession";
DROP TABLE "PreWarmedSession";
ALTER TABLE "new_PreWarmedSession" RENAME TO "PreWarmedSession";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
