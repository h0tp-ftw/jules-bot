-- AlterTable
ALTER TABLE "DebugSession" ADD COLUMN "lastDeliveredActivityId" TEXT;
ALTER TABLE "DebugSession" ADD COLUMN "lastDeliveredActivityAt" DATETIME;
ALTER TABLE "DebugSession" ADD COLUMN "deliveryCursorInitialized" BOOLEAN NOT NULL DEFAULT false;
