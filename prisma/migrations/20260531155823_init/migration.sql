-- CreateTable
CREATE TABLE "GuildConfig" (
    "guildId" TEXT NOT NULL PRIMARY KEY,
    "defaultRepo" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DebugSession" (
    "threadId" TEXT NOT NULL PRIMARY KEY,
    "guildId" TEXT NOT NULL,
    "julesSessionId" TEXT NOT NULL,
    "statusMessageId" TEXT,
    "planMessageId" TEXT,
    "repoName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
