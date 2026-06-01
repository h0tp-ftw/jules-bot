-- CreateTable
CREATE TABLE "PreWarmedSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
