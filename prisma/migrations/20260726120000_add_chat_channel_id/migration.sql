-- Add a designated normal text channel that shares one conversational Jules session.
ALTER TABLE "GuildConfig" ADD COLUMN "chatChannelId" TEXT;
