import { readFile } from "node:fs/promises";
import { GraphitiClient } from "../graphiti-client.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import type { GraphitiWriteBatch, NormalizedMessage } from "../types.js";
import { createRunId, detectMention, normalizeCreateTime } from "../utils.js";

/**
 * This script imports an exported WeFlow chat JSON file into Graphiti.
 *
 * Unlike the real-time event-gateway flow, this script is for offline replay:
 * - read a historical export file from disk
 * - normalize messages into the same internal shape used by the gateway
 * - split them into batches
 * - send each batch to Graphiti through the existing MCP client
 */

// Change this path when you want to import a different export file.
const INPUT_FILE_PATH =
  "F:\\project\\wxDataBasePickerCache\\export\\texts\\WeChat Robot.json";

// How many text messages to send in one Graphiti batch.
const BATCH_SIZE = 80;

// Optional pause between batches. Keep 0 for fastest import.
const PAUSE_MS_BETWEEN_BATCHES = 0;

/**
 * For now we only want plain text history in Graphiti.
 * These placeholder contents represent media messages and will be skipped.
 *
 * If you want to relax the rule later, change this set or shouldImportMessage().
 */
const SKIPPED_CONTENT_VALUES = new Set(["[图片]", "[视频]", "[语音]"]);

/**
 * 当前这几个 senderUsername 也先排除在历史导入之外。
 * 这通常适合处理你暂时不希望写入长期记忆的固定账号。
 */
const SKIPPED_SENDER_USERNAMES = new Set([
  "wxid_72ow1edm3kea22",
  "wxid_b28npmhznnwl12",
  "wxid_vprfp0sk2o7y22",
  "wxid_ass85tknzqiu22",
]);

interface ExportedChatFile {
  session: {
    wxid: string;
    nickname?: string;
    displayName?: string;
    type?: string;
    messageCount?: number;
  };
  messages: ExportedChatMessage[];
}

interface ExportedChatMessage {
  localId: number;
  createTime: number;
  type?: string;
  content?: string | null;
  isSend: number;
  senderUsername?: string;
  senderDisplayName?: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (!config.graphitiMcpUrl) {
    throw new Error("当前没有配置 GRAPHITI_MCP_URL，无法导入历史消息到 Graphiti");
  }

  logger.info({ inputFilePath: INPUT_FILE_PATH }, "开始读取历史聊天导出文件");

  const file = await loadExportedChatFile(INPUT_FILE_PATH);
  const sessionId = file.session.wxid;
  const groupName = file.session.displayName || file.session.nickname || sessionId;

  const importableMessages = file.messages.filter((message) => shouldImportMessage(message));
  const skippedMessageCount = file.messages.length - importableMessages.length;

  logger.info(
    {
      sessionId,
      groupName,
      exportedMessageCount: file.messages.length,
      importableMessageCount: importableMessages.length,
      skippedMessageCount,
      configuredBatchSize: BATCH_SIZE,
    },
    "历史聊天文件读取完成，开始整理可导入的纯文字消息",
  );

  if (importableMessages.length === 0) {
    logger.warn(
      {
        sessionId,
        groupName,
      },
      "当前过滤规则下没有可导入的纯文字消息，跳过本次 Graphiti 导入",
    );
    return;
  }

  const normalizedMessages = importableMessages.map((message) =>
    normalizeHistoryMessage(message, sessionId, groupName, config.botProfile),
  );
  const batches = chunkMessages(normalizedMessages, BATCH_SIZE);

  logger.info(
    {
      sessionId,
      groupName,
      importableMessageCount: normalizedMessages.length,
      batchCount: batches.length,
    },
    "历史聊天已切分为多个 Graphiti 导入批次",
  );

  const graphitiClient = new GraphitiClient(config, logger);
  await graphitiClient.start();

  try {
    for (const [index, messages] of batches.entries()) {
      const batch = buildGraphitiBatch(sessionId, groupName, messages);

      logger.info(
        {
          sessionId,
          batchIndex: index + 1,
          batchCount: batches.length,
          firstLocalId: messages[0]?.localId,
          lastLocalId: messages.at(-1)?.localId,
          messageCount: messages.length,
        },
        "开始导入一批历史文字消息到 Graphiti",
      );

      await graphitiClient.addMessages(batch);

      if (PAUSE_MS_BETWEEN_BATCHES > 0) {
        await sleep(PAUSE_MS_BETWEEN_BATCHES);
      }
    }
  } finally {
    await graphitiClient.stop();
  }

  logger.info(
    {
      sessionId,
      groupName,
      batchCount: batches.length,
      importedMessageCount: normalizedMessages.length,
      skippedMessageCount,
    },
    "历史聊天导入任务已提交给 Graphiti，后端仍会异步处理，节点会稍后出现",
  );
}

/**
 * Read and parse the exported chat file from disk.
 * This function only handles file IO and JSON parsing.
 */
async function loadExportedChatFile(filePath: string): Promise<ExportedChatFile> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as ExportedChatFile;
}

/**
 * Decide whether a historical message should be imported right now.
 *
 * Current rule:
 * - null / undefined / blank content -> skip
 * - [图片] / [视频] / [语音] -> skip
 * - senderUsername 命中跳过名单 -> skip
 * - everything else -> keep
 *
 * We keep this logic isolated on purpose so future changes stay small.
 */
function shouldImportMessage(message: ExportedChatMessage): boolean {
  const content = message.content?.trim();
  if (!content) {
    return false;
  }

  const senderUsername = message.senderUsername?.trim();
  if (senderUsername && SKIPPED_SENDER_USERNAMES.has(senderUsername)) {
    return false;
  }

  return !SKIPPED_CONTENT_VALUES.has(content);
}

/**
 * Convert one exported history message into the same NormalizedMessage shape
 * used elsewhere in the project. This lets the history importer reuse the
 * same Graphiti writing path as the real-time gateway.
 */
function normalizeHistoryMessage(
  message: ExportedChatMessage,
  sessionId: string,
  groupName: string,
  botProfile: { name: string; aliases: string[]; wechatIds: string[] },
): NormalizedMessage {
  const createdAtUnixMs = normalizeCreateTime(message.createTime);
  const senderId =
    message.senderUsername?.trim() ||
    (message.isSend === 1 ? botProfile.wechatIds[0] || botProfile.name : "unknown");
  const senderName =
    message.senderDisplayName?.trim() ||
    message.senderUsername?.trim() ||
    (message.isSend === 1 ? botProfile.name : "unknown");
  const content = normalizeMessageContent(message);
  const isSelfSent = message.isSend === 1;
  const isFromBot = isSelfSent || botProfile.wechatIds.includes(senderId);

  return {
    sessionId,
    groupName,
    localId: message.localId,
    serverId: undefined,
    senderId,
    senderName,
    timestamp: new Date(createdAtUnixMs).toISOString(),
    createdAtUnixMs,
    content,
    rawContent: content,
    contentType: "text",
    isGroup: true,
    isSelfSent,
    isFromBot,
    isMentionBot: detectMention(content, botProfile),
    fingerprint: `${sessionId}:${message.localId}`,
  };
}

/**
 * By the time we reach this function, media placeholders should already have
 * been filtered out. We still keep a tiny defensive fallback here so the
 * importer remains stable if future test data is messy.
 */
function normalizeMessageContent(message: ExportedChatMessage): string {
  const content = message.content?.trim();
  if (content) {
    return content;
  }

  const messageType = message.type?.trim() || "未知消息";
  return `[${messageType}]`;
}

/**
 * Split the normalized messages into fixed-size batches before writing them.
 * If you later want time-gap-based batching, change this function.
 */
function chunkMessages(messages: NormalizedMessage[], batchSize: number): NormalizedMessage[][] {
  const batches: NormalizedMessage[][] = [];

  for (let index = 0; index < messages.length; index += batchSize) {
    batches.push(messages.slice(index, index + batchSize));
  }

  return batches;
}

/**
 * Build the same GraphitiWriteBatch structure used by the real-time flow.
 * This keeps the history importer and the live gateway on one write contract.
 */
function buildGraphitiBatch(
  sessionId: string,
  groupName: string,
  messages: NormalizedMessage[],
): GraphitiWriteBatch {
  return {
    runId: createRunId(),
    sessionId,
    groupName,
    triggerReason: "quiet_window",
    messages,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
