import {
  ThreadChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
} from "discord.js";
import { JulesClient } from "./JulesClient.js";
import { StreamManager } from "../streams/StreamManager.js";
import { prisma, getEffectiveConfig, yamlConfig } from "../../config.js";
import { replenishPool } from "./PreWarmedManager.js";
import { processAttachments } from "../utils/docling.js";
import { resolveMessageEmojis } from "../utils/emojis.js";
import { splitMessage } from "../utils/messageSplitter.js";

export const activeStreams = new Set<string>();
export const autoRejectedSessions = new Set<string>();
export const processedActivityIdsMap = new Map<string, Set<string>>();
// Tracks the last reaction stage applied to a given message id so updateReaction
// can skip redundant remove/re-add API calls when the stage hasn't changed.
const messageReactionStage = new Map<string, string>();

function parseEmojiForReaction(client: any, emojiStr: string): string {
  const trimmed = emojiStr.trim();
  // Match <:name:id> or <a:name:id>
  const match = trimmed.match(/^<a?:([a-zA-Z0-9_]+):([0-9]+)>$/);
  if (match) {
    return `${match[1]}:${match[2]}`;
  }

  // Match raw name:id
  const rawMatch = trimmed.match(/^([a-zA-Z0-9_]+):([0-9]+)$/);
  if (rawMatch) {
    return trimmed;
  }

  // Match raw ID
  if (/^[0-9]+$/.test(trimmed)) {
    const cachedEmoji = client.emojis.cache.get(trimmed);
    if (cachedEmoji) {
      return `${cachedEmoji.name}:${cachedEmoji.id}`;
    }
    return trimmed;
  }

  return trimmed;
}

export async function getLastHumanMessage(
  thread: ThreadChannel,
): Promise<Message | null> {
  try {
    const messages = await thread.messages.fetch({ limit: 20 });
    const sorted = Array.from(messages.values()).sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    );
    const lastHuman = sorted.find((m) => !m.author.bot);
    return lastHuman || null;
  } catch (err) {
    console.error("Failed to fetch last human message for reply:", err);
    return null;
  }
}

export async function updateReaction(
  message: Message | null,
  newStage: string,
) {
  if (!message) return;
  // Skip redundant work if this message is already showing the target stage.
  if (messageReactionStage.get(message.id) === newStage) return;
  try {
    const botId = message.client.user?.id;
    if (botId) {
      // Remove any existing bot reactions to clean up previous stages
      for (const reaction of message.reactions.cache.values()) {
        try {
          if (reaction.me) {
            await reaction.users.remove(botId);
          }
        } catch (err) {
          // Ignore removal errors
        }
      }
    }

    // Add new reaction emoji
    const threadConfig = getEffectiveConfig(message.channel, message.member);
    const reactions = threadConfig.reactions || {};
    const emojiStr = reactions[newStage];
    if (emojiStr) {
      const emoji = parseEmojiForReaction(message.client, emojiStr);
      await message.react(emoji);
    }
    messageReactionStage.set(message.id, newStage);
  } catch (err) {
    console.error(`Failed to update reaction to stage ${newStage}:`, err);
  }
}

export async function getFreshSessionInfo(session: any): Promise<any> {
  try {
    if (session && session.sessionStorage && typeof session.sessionStorage.delete === 'function') {
      await session.sessionStorage.delete(session.id);
    }
  } catch (err) {
    console.error(`[getFreshSessionInfo] Failed to delete cache for session ${session?.id}:`, err);
  }
  return await session.info();
}

export async function runJulesStream(
  sessionId: string,
  thread: ThreadChannel,
  streamManager: StreamManager,
  initialProcessedIds?: Set<string>,
) {
  if (activeStreams.has(thread.id)) {
    console.log(
      `[runJulesStream] activeStreams already has thread ${thread.id}. Exiting stream handler creation.`,
    );
    return;
  }
  activeStreams.add(thread.id);
  console.log(
    `[runJulesStream] Starting stream handler for thread ${thread.id}, sessionId: ${sessionId}`,
  );

  let typingInterval: NodeJS.Timeout | null = null;

  const startTyping = () => {
    if (typingInterval) return;
    thread.sendTyping().catch(() => {});
    typingInterval = setInterval(() => {
      thread.sendTyping().catch(() => {});
    }, 8000);
  };

  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  };

  let processedActivityIds = processedActivityIdsMap.get(thread.id);
  if (!processedActivityIds) {
    processedActivityIds = initialProcessedIds || new Set<string>();
    processedActivityIdsMap.set(thread.id, processedActivityIds);
    if (!initialProcessedIds) {
      try {
        const session = JulesClient.getSession(sessionId);
        console.log(
          `[runJulesStream] Pre-populating processed activities for thread ${thread.id} from history...`,
        );
        for await (const act of session.history()) {
          processedActivityIds.add(act.id);
        }
        console.log(
          `[runJulesStream] Pre-populated ${processedActivityIds.size} activities.`,
        );
      } catch (err) {
        console.error(
          `Failed to pre-populate processed activities for thread ${thread.id}:`,
          err,
        );
      }
    } else {
      console.log(
        `[runJulesStream] Using provided initial processed activity IDs (count: ${processedActivityIds.size})`,
      );
    }
  }
  let consecutiveFailures = 0;
  const maxRetries = 20;
  let retryDelay = 5000;

  // Cache the "last human message" used as the reaction/reply target. Fetching it
  // hits the Discord REST API, so fetch once and only refresh when a new user
  // message arrives (userMessaged) instead of re-fetching on every activity.
  let cachedTarget: Message | null = null;
  let targetFetched = false;
  const getTarget = async (forceRefresh = false): Promise<Message | null> => {
    if (forceRefresh || !targetFetched) {
      const fetched = await getLastHumanMessage(thread);
      if (fetched) {
        cachedTarget = fetched;
        targetFetched = true;
      }
    }
    return cachedTarget;
  };

  while (consecutiveFailures < maxRetries) {
    try {
      if (thread.archived) {
        console.log(`[runJulesStream] Thread ${thread.id} is archived. Exiting stream handler.`);
        stopTyping();
        activeStreams.delete(thread.id);
        processedActivityIdsMap.delete(thread.id);
        return;
      }

      console.log(`[runJulesStream] Fetching session info for ${sessionId}...`);
      const session = JulesClient.getSession(sessionId);
      let info = await getFreshSessionInfo(session);
      console.log(
        `[runJulesStream] Session ${sessionId} info: state=${info?.state}`,
      );

      if (!info) {
        console.log(`Session ${sessionId} not found or deleted on backend. Exiting stream handler.`);
        stopTyping();
        activeStreams.delete(thread.id);
        processedActivityIdsMap.delete(thread.id);
        return;
      }

      if (info && info.state === "failed") {
        console.log(`Session ${sessionId} is failed. Exiting stream handler.`);
        stopTyping();
        activeStreams.delete(thread.id);
        processedActivityIdsMap.delete(thread.id);
        return;
      }

      const threadConfig = getEffectiveConfig(thread);
      const typingMode = threadConfig.typing_indicator_mode || "until_response";

      if (
        info &&
        (info.state === "inProgress" ||
          info.state === "planning" ||
          info.state === "queued")
      ) {
        startTyping();
      } else {
        stopTyping();
      }

      if (info && info.state === "queued") {
        const targetMessage = await getTarget();
        await updateReaction(targetMessage, "queued");
      }
      let queuedWaitMs = 0;
      const maxQueuedWaitMs = 2 * 60 * 1000; // 2 minutes max
      while (info && info.state === "queued") {
        if (queuedWaitMs >= maxQueuedWaitMs) {
          console.error(
            `Session ${sessionId} stuck in queued state for too long. Aborting.`,
          );
          await thread.send(
            "⚠️ Jules session timed out waiting to start. Please open a new thread.",
          );
          activeStreams.delete(thread.id);
          processedActivityIdsMap.delete(thread.id);
          autoRejectedSessions.delete(sessionId);
          stopTyping();
          return;
        }
        console.log(`[runJulesStream] is queued. Waiting 5s...`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        queuedWaitMs += 5000;
        info = await getFreshSessionInfo(session);
      }

      const targetMessage = await getTarget();
      await updateReaction(targetMessage, "in_progress");
      if (
        info &&
        (info.state === "inProgress" ||
          info.state === "planning" ||
          info.state === "queued")
      ) {
        startTyping();
      }

      let agentMessagedInThisTurn = false;

      console.log(
        `[runJulesStream] Subscribing to session stream for ${sessionId}...`,
      );
      for await (const activity of session.stream()) {
        const id = activity.id;
        console.log(
          `[runJulesStream] Received activity from stream: ${id} type=${activity.type} originator=${activity.originator}`,
        );
        if (processedActivityIds.has(id)) {
          console.log(
            `[runJulesStream] Activity ${id} already processed. Skipping.`,
          );
          continue;
        }
        processedActivityIds.add(id);
        consecutiveFailures = 0;
        retryDelay = 5000;

        const type = activity.type;
        const typeStr = type as string;

        switch (type) {
          case "planGenerated": {
            console.log(`[runJulesStream] planGenerated for ${sessionId}`);
            const plan = activity.plan || (activity as any).planGenerated?.plan;
            if (!plan || !plan.steps) break;

            const lastHuman = await getTarget();
            const threadConfig = getEffectiveConfig(thread, lastHuman?.member);
            const autoReject = threadConfig.auto_reject || {};
            const shouldAutoReject =
              autoReject.enabled && !autoRejectedSessions.has(sessionId);
            if (shouldAutoReject) {
              autoRejectedSessions.add(sessionId);
              const feedback =
                autoReject.message ||
                "Please do not create or refine an implementation plan. Instead, just talk directly with me to understand the goals and discuss the issue.";
              await thread.send(
                `🤖 **Plan Automatically Rejected:**\nFeedback: "${feedback}"\nJules is revising the plan...`,
              );
              await session.send(feedback);
              const target = await getTarget();
              await updateReaction(target, "in_progress");
              break;
            }

            const target = await getTarget();
            await updateReaction(target, "awaiting_plan_approval");

            const stepsText = plan.steps
              .map((step: any, i: number) => `**${i + 1}.** ${step.title}`)
              .join("\n");

            const embed = new EmbedBuilder()
              .setTitle(
                `${threadConfig.bot_emoji || "🐙"} Jules Proposed Diagnostic Plan`,
              )
              .setDescription(
                stepsText.slice(0, 4000) || "No details provided.",
              )
              .setColor(0x00ae86);

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`plan-approve:${thread.id}`)
                .setLabel("Approve Plan")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`plan-reject:${thread.id}`)
                .setLabel("Reject Plan")
                .setStyle(ButtonStyle.Danger),
            );

            const msg = await thread.send({
              embeds: [embed],
              components: [row],
            });

            await prisma.debugSession.update({
              where: { threadId: thread.id },
              data: { planMessageId: msg.id },
            });
            break;
          }

          case "progressUpdated": {
            console.log(`[runJulesStream] progressUpdated for ${sessionId}`);
            // If we were awaiting approval, go back to in_progress on updates
            const target = await getTarget();
            await updateReaction(target, "in_progress");
            const title =
              activity.title || (activity as any).progressUpdated?.title || "";
            const description =
              activity.description ||
              (activity as any).progressUpdated?.description ||
              "";
            const logLine = description ? `${title}\n${description}` : title;
            if (logLine) {
              await streamManager.handleProgress(thread.id, logLine);
            }
            break;
          }

          case "agentMessaged": {
            console.log(`[runJulesStream] agentMessaged for ${sessionId}`);
            const message =
              activity.message ||
              (activity as any).agentMessaged?.message ||
              "";
            if (message) {
              const resolved = resolveMessageEmojis(thread.client, message);
              const lastHuman = await getTarget();
              if (lastHuman) {
                let splits = splitMessage(resolved, 2000);
                for (let i = 0; i < splits.length; i++) {
                  if (i === 0) {
                    await lastHuman.reply(splits[i]);
                  } else {
                    await thread.send(splits[i]);
                  }
                }
              } else {
                let splits = splitMessage(resolved, 2000);
                for (let chunk of splits) {
                  await thread.send(chunk);
                }
              }
              const target = await getTarget();
              await updateReaction(target, "responded");
            }
            break;
          }

          case "sessionCompleted": {
            console.log(`[runJulesStream] sessionCompleted for ${sessionId}`);
            const target = await getTarget();
            await updateReaction(target, "completed");
            await streamManager.finalizeSession(thread.id, true);
            autoRejectedSessions.delete(sessionId);
            stopTyping();
            break;
          }

          case "sessionFailed": {
            console.log(`[runJulesStream] sessionFailed for ${sessionId}`);
            const target = await getTarget();
            await updateReaction(target, "failed");
            const reason =
              activity.reason || (activity as any).sessionFailed?.reason || "";
            await streamManager.finalizeSession(thread.id, false, reason);
            activeStreams.delete(thread.id);
            processedActivityIdsMap.delete(thread.id);
            autoRejectedSessions.delete(sessionId);
            stopTyping();
            return;
          }

          case "userMessaged": {
            console.log(`[runJulesStream] userMessaged for ${sessionId}`);
            // A new human message arrived — refresh the cached reaction/reply target.
            await getTarget(true);
            // Typing indicators handled below.
            break;
          }
        }

        // Check typing mode to update typing status (offline, no network calls)
        try {
          const threadConfig = getEffectiveConfig(thread);
          const typingMode =
            threadConfig.typing_indicator_mode || "until_response";

          if (typingMode === "strict_state") {
            // Strict state mode: keep typing active during progress updates,
            // and only stop typing when the session is completed or failed.
            if (typeStr === "userMessaged" || typeStr === "progressUpdated") {
              startTyping();
            } else if (typeStr === "sessionCompleted" || typeStr === "sessionFailed") {
              stopTyping();
            }
          } else {
            // Default mode: until_response
            // Start typing when a user message is sent, stop when agent responds or session ends.
            if (typeStr === "userMessaged") {
              startTyping();
            } else if (
              typeStr === "agentMessaged" ||
              typeStr === "planGenerated" ||
              typeStr === "sessionCompleted" ||
              typeStr === "sessionFailed"
            ) {
              stopTyping();
            }
          }
        } catch (typingErr) {
          console.error(
            "[runJulesStream] Failed to update typing status:",
            typingErr,
          );
        }
      }

      console.log(`[runJulesStream] Stream loop finished for ${sessionId}.`);
      stopTyping();
    } catch (err: any) {
      consecutiveFailures++;
      console.error(
        `[runJulesStream] [Stream Retry ${consecutiveFailures}/${maxRetries}] Error in Jules stream for thread ${thread.id}:`,
        err,
      );

      if (consecutiveFailures >= maxRetries) {
        const errorMsg =
          err instanceof Error ? err.stack || err.message : String(err);
        await thread.send(
          `❌ **The diagnostic analysis session failed after multiple reconnection attempts:**\n\`\`\`ts\n${errorMsg.slice(0, 1800)}\n\`\`\``,
        );
        break;
      }

      console.log(`Reconnecting stream in ${retryDelay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 1.5, 30000);
    } finally {
      stopTyping();
    }
  }

  console.log(
    `[runJulesStream] Exited outer while loop for thread ${thread.id}`,
  );
  activeStreams.delete(thread.id);
}

export async function initializeJulesSession(
  thread: ThreadChannel,
  repoName: string,
  branchName: string,
  streamManager: StreamManager,
) {
  const starterMessage = await thread.fetchStarterMessage();
  if (
    !starterMessage ||
    (!starterMessage.content && starterMessage.attachments.size === 0)
  ) {
    await thread.send(
      "⚠️ **Could not retrieve the starter message for this thread. Please reply with your issue details to start.**",
    );
    return;
  }

  const authorNickname =
    starterMessage.member?.displayName || starterMessage.author.username;
  const authorUsername = starterMessage.author.username;
  const authorId = starterMessage.author.id;
  const messageTime = starterMessage.createdAt.toISOString();
  const threadTitle = thread.name;

  let starterContent = starterMessage.content || "";
  if (starterMessage.attachments.size > 0) {
    const attachmentList = Array.from(starterMessage.attachments.values()).map(
      (att) => ({
        name: att.name,
        url: att.url,
      }),
    );
    const parsedAttachments = await processAttachments(attachmentList, thread);
    starterContent += parsedAttachments;
  }

  const promptWithMetadata = `[Message details - Author Nickname: ${authorNickname}, Author Username: ${authorUsername}, Author Discord ID: ${authorId}, Message Time: ${messageTime}, Issue/Thread Title: ${threadTitle}]\n\n${starterContent}`;

  let session: any = null;
  let usedPreWarmed = false;
  let initialSkipIds: Set<string> | undefined;
  let welcomePlanRejected = false;
  let welcomeFeedback = "";

  const threadConfig = getEffectiveConfig(thread, starterMessage.member);

  // Determine matching contextKey and pool eligibility
  let contextKey: string | null = null;
  let usePool = false;

  const channelsConfig = yamlConfig.channels || {};
  const rolesConfig = yamlConfig.roles || {};

  if (
    thread.id &&
    channelsConfig[thread.id] &&
    channelsConfig[thread.id].pre_warmed_sessions?.enabled
  ) {
    contextKey = thread.id;
    usePool = true;
  } else if (
    thread.parentId &&
    channelsConfig[thread.parentId] &&
    channelsConfig[thread.parentId].pre_warmed_sessions?.enabled
  ) {
    contextKey = thread.parentId;
    usePool = true;
  } else {
    // Check roles
    if (starterMessage.member && starterMessage.member.roles) {
      for (const [roleKey, roleVal] of Object.entries(rolesConfig)) {
        let hasRole = false;
        const roles = starterMessage.member.roles as any;
        if (roles && roles.cache) {
          hasRole =
            roles.cache.has(roleKey) ||
            roles.cache.some((r: any) => r.name === roleKey);
        } else if (Array.isArray(roles)) {
          hasRole = roles.includes(roleKey);
        }
        if (
          hasRole &&
          roleVal &&
          typeof roleVal === "object" &&
          (roleVal as any).pre_warmed_sessions?.enabled
        ) {
          contextKey = roleKey;
          usePool = true;
          break;
        }
      }
    }
  }

  if (!usePool) {
    // Check if global pool is enabled and prompts are NOT overridden
    const globalConfig = getEffectiveConfig();
    const isPromptOverridden =
      threadConfig.diagnostic_prompt !== globalConfig.diagnostic_prompt ||
      threadConfig.agents_personality !== globalConfig.agents_personality ||
      threadConfig.soul_personality !== globalConfig.soul_personality;

    if (threadConfig.pre_warmed_sessions.enabled && !isPromptOverridden) {
      contextKey = null;
      usePool = true;
    }
  }

  // Pre-warmed sessions are currently only created for the default branch (usually 'main')
  const isDefaultBranch =
    branchName === (threadConfig.default_branch || "main");

  if (usePool && isDefaultBranch) {
    let preWarmed = await prisma.preWarmedSession.findFirst({
      where: { repoName, ready: true, contextKey },
      orderBy: { createdAt: "asc" },
    });

    if (!preWarmed) {
      const warming = await prisma.preWarmedSession.findFirst({
        where: { repoName, ready: false, contextKey },
        orderBy: { createdAt: "asc" },
      });
      if (warming) {
        const statusMsg = await thread.send(
          "⏳ **A session is currently pre-warming. Waiting for it to become ready...**",
        );
        for (let attempt = 0; attempt < 12; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          const check = await prisma.preWarmedSession.findUnique({
            where: { id: warming.id },
          });
          if (check && check.ready) {
            preWarmed = check;
            break;
          }
        }
        await statusMsg.delete().catch(() => {});
      }
    }

    if (preWarmed) {
      try {
        session = JulesClient.getSession(preWarmed.id);

        const info = await getFreshSessionInfo(session);
        console.log(
          `[initializeJulesSession] Session ${session.id} state at consumption: ${info.state}`,
        );

        if (info && (info.state === "failed" || info.state === "completed")) {
          console.warn(
            `[initializeJulesSession] Session ${session.id} is in ${info.state} state. Discarding and creating new session.`,
          );
          await prisma.preWarmedSession.delete({ where: { id: preWarmed.id } });
          throw new Error(
            `Pre-warmed session ${session.id} is in ${info.state} state`,
          );
        }

        // Load history activities for the pre-warmed session to get greeting/plans
        const activities: any[] = [];
        try {
          for await (const act of session.history()) {
            activities.push(act);
          }
        } catch (histErr) {
          console.error(
            `[initializeJulesSession] Failed to fetch history for pre-warmed session ${session.id}:`,
            histErr,
          );
        }

        // If auto-reject is enabled, we check if there's any active plan to reject
        if (threadConfig.auto_reject?.enabled) {
          const hasActivePlan = !!(info as any).plan;
          const hasPlanInHistory = activities.some(
            (a: any) => a.type === "planGenerated",
          );

          if (
            hasActivePlan ||
            hasPlanInHistory ||
            info.state === "awaitingPlanApproval"
          ) {
            console.log(
              `[initializeJulesSession] Plan detected for session ${session.id} (Active: ${hasActivePlan}, History: ${hasPlanInHistory}, State: ${info.state}). Marking for rejection.`,
            );
            welcomePlanRejected = true;
            welcomeFeedback =
              threadConfig.auto_reject?.message ||
              "Please do not create or refine an implementation plan. Instead, just talk directly with me to understand the goals and discuss the issue.";
          }
        }

        if (activities.length > 0) {
          console.log(
            `[initializeJulesSession] Session ${session.id} has ${activities.length} activities.`,
          );
          initialSkipIds = new Set(activities.map((a: any) => a.id));
          for (const activity of activities) {
            console.log(
              `[initializeJulesSession] Activity Type: ${activity.type}`,
            );
            if (activity.type === "agentMessaged") {
              const message =
                activity.message ||
                (activity as any).agentMessaged?.message ||
                "";
              if (message) {
                const resolved = resolveMessageEmojis(thread.client, message);
                let splits = splitMessage(resolved, 2000);
                for (let chunk of splits) {
                  await thread.send(chunk);
                }
              }
            } else if (activity.type === "planGenerated") {
              const plan =
                activity.plan || (activity as any).planGenerated?.plan;
              if (plan && plan.steps) {
                console.log(
                  `[initializeJulesSession] Rendering plan from history for session ${session.id}`,
                );
                const stepsText = plan.steps
                  .map((step: any, i: number) => `**${i + 1}.** ${step.title}`)
                  .join("\n");

                const embed = new EmbedBuilder()
                  .setTitle(
                    `${threadConfig.bot_emoji || "🐙"} Jules Proposed Diagnostic Plan`,
                  )
                  .setDescription(
                    stepsText.slice(0, 4000) || "No details provided.",
                  )
                  .setColor(0x00ae86)
                  .setFooter({ text: "Welcome plan detected." });

                await thread.send({ embeds: [embed] });
              }
            }
          }
        }

        if (welcomePlanRejected) {
          autoRejectedSessions.add(session.id);
          const botEmoji = threadConfig.bot_emoji || "🐙";
          console.log(
            `[initializeJulesSession] Automatically rejecting welcome plan for pre-warmed session ${session.id}`,
          );
          await thread.send(
            `${botEmoji} **Plan Automatically Rejected:**\nFeedback: "${welcomeFeedback}"\nJules is revising the plan...`,
          );
        }

        await prisma.preWarmedSession.delete({
          where: { id: preWarmed.id },
        });

        usedPreWarmed = true;
        console.log(
          `[initializeJulesSession] Consumed pre-warmed session ${session.id} for repo ${repoName} (Context: ${contextKey || "global"})`,
        );
      } catch (err) {
        console.error(
          `[initializeJulesSession] Failed to rehydrate pre-warmed session ${preWarmed.id}:`,
          err,
        );
        session = null;
      }
    }
  }

  if (!session) {
    session = await JulesClient.createSession({
      prompt: promptWithMetadata,
      repo: repoName,
      branch: branchName,
      title: thread.name,
      thread: thread,
      member: starterMessage.member,
    });
  }

  await prisma.debugSession.create({
    data: {
      threadId: thread.id,
      guildId: thread.guildId,
      julesSessionId: session.id,
      repoName: repoName,
    },
  });

  // Ensure autoRejectedSessions entry persists if we rejected a plan during initialization,
  // so runJulesStream doesn't try to reject the SAME plan again.
  // We will only delete it AFTER the user prompt is sent and we want to allow a NEW rejection.

  // Start processing events in the background
  if (!usedPreWarmed) {
    runJulesStream(session.id, thread, streamManager, initialSkipIds);
  }

  if (usedPreWarmed) {
    await thread.send("🚀 **Ready session found! Processing your issue...**");
    thread.sendTyping().catch(() => {});

    if (welcomePlanRejected) {
      // Send rejection separately BEFORE the user prompt
      const rejectionDirective = `[System Directive: Auto-Reject Plan]\nFeedback: "${welcomeFeedback}"\n\nPlease do not create or refine an implementation plan. Respond directly to the user's prompt.`;
      console.log(
        `[initializeJulesSession] Sending auto-rejection directive for session ${session.id}`,
      );
      await session.send(rejectionDirective);

      // Wait for it to process the rejection so it's ready for the prompt
      console.log(
        `[initializeJulesSession] Waiting for session ${session.id} to process rejection...`,
      );
      for (let i = 0; i < 20; i++) {
        const info = await getFreshSessionInfo(session);
        if (info.state !== "queued") {
          console.log(
            `[initializeJulesSession] Session ${session.id} finished processing rejection (State: ${info.state})`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Briefly wait for any immediate follow-up activities to settle
      await new Promise((r) => setTimeout(r, 2000));

      // Now that we've rejected the welcome plan, we clear the set so that the
      // FIRST plan for the ACTUAL prompt can also be rejected.
      autoRejectedSessions.delete(session.id);
    }

    console.log(
      `[initializeJulesSession] Sending user prompt to session ${session.id}`,
    );
    await session.send(promptWithMetadata);

    // Start processing events in the background for prewarmed session after sending the prompt
    runJulesStream(session.id, thread, streamManager, initialSkipIds);

    replenishPool(repoName, contextKey).catch(() => {});
  } else if (usePool) {
    replenishPool(repoName, contextKey).catch(() => {});
  }
}

export async function rehydrateActiveStreams(client: any, streamManager: StreamManager) {
  console.log('[rehydrateActiveStreams] Starting rehydration of active streams...');
  try {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const sessions = await prisma.debugSession.findMany({
      where: {
        updatedAt: { gte: oneWeekAgo },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    console.log(`[rehydrateActiveStreams] Found ${sessions.length} sessions in DB updated in the last 7 days.`);

    for (const session of sessions) {
      try {
        const channel = await client.channels.fetch(session.threadId);
        if (!channel || !channel.isThread()) continue;
        const thread = channel as ThreadChannel;
        if (thread.archived || thread.locked) {
          console.log(`[rehydrateActiveStreams] Thread ${thread.id} is archived or locked. Skipping.`);
          continue;
        }

        console.log(`[rehydrateActiveStreams] Rehydrating stream for thread ${thread.id}, sessionId: ${session.julesSessionId}`);
        // runJulesStream checks if it's already active, so this is safe
        runJulesStream(session.julesSessionId, thread, streamManager);
      } catch (err) {
        console.error(`[rehydrateActiveStreams] Failed to rehydrate session ${session.julesSessionId} for thread ${session.threadId}:`, err);
      }
    }
  } catch (err) {
    console.error('[rehydrateActiveStreams] Failed to query active sessions from database:', err);
  }
}
