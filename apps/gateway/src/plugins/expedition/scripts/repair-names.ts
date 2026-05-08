import { and, eq } from "drizzle-orm";
import { loadConfig } from "../../../config.js";
import { PostgresStore } from "../../../db/index.js";
import { createLogger } from "../../../infra/logger.js";
import { WechatAdminClient } from "../../../integrations/wechat-admin-client.js";
import { ChatRoomMemberNameResolver } from "../../../messaging/member-name-resolver.js";
import {
  expeditionEntries,
  expeditionPlayers,
  expeditionReports,
} from "../expedition-schema.js";

interface SenderKey {
  sessionId: string;
  senderId: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const postgres = new PostgresStore(config, logger);
  const wechatAdminClient = WechatAdminClient.fromConfig(config);
  if (!wechatAdminClient.isConfigured()) {
    throw new Error(
      `修复远征展示名需要配置：${wechatAdminClient.getMissingConfigKeys().join(", ")}`,
    );
  }

  const memberNameResolver = new ChatRoomMemberNameResolver(wechatAdminClient, logger);

  try {
    await postgres.ping();
    const senderKeys = await collectSenderKeys(postgres.db);
    let resolvedCount = 0;
    let skippedCount = 0;
    let updatedEntries = 0;
    let updatedPlayers = 0;
    let updatedReports = 0;

    for (const senderKey of senderKeys) {
      const senderName = await memberNameResolver.resolveSenderName({
        sessionId: senderKey.sessionId,
        senderId: senderKey.senderId,
        currentSenderName: senderKey.senderId,
      });

      if (senderName === senderKey.senderId) {
        skippedCount += 1;
        console.log(`跳过：${senderKey.sessionId} / ${senderKey.senderId} 未解析到展示名`);
        continue;
      }

      const result = await repairSenderName(postgres.db, senderKey, senderName);
      resolvedCount += 1;
      updatedEntries += result.entries;
      updatedPlayers += result.players;
      updatedReports += result.reports;
      console.log(
        [
          `修复：${senderKey.sessionId} / ${senderKey.senderId} -> ${senderName}`,
          `entries=${result.entries}`,
          `players=${result.players}`,
          `reports=${result.reports}`,
        ].join("，"),
      );
    }

    console.log("");
    console.log("远征展示名修复完成");
    console.log(`解析成功：${resolvedCount}`);
    console.log(`跳过：${skippedCount}`);
    console.log(`更新 expedition_entries：${updatedEntries}`);
    console.log(`更新 expedition_players：${updatedPlayers}`);
    console.log(`更新 expedition_reports：${updatedReports}`);
  } finally {
    await postgres.disconnect();
  }
}

async function collectSenderKeys(db: PostgresStore["db"]): Promise<SenderKey[]> {
  const senderKeys = new Map<string, SenderKey>();
  const add = (row: SenderKey): void => {
    senderKeys.set(`${row.sessionId}:${row.senderId}`, row);
  };

  const [entryRows, playerRows, reportRows] = await Promise.all([
    db.select({
      sessionId: expeditionEntries.sessionId,
      senderId: expeditionEntries.senderId,
    }).from(expeditionEntries),
    db.select({
      sessionId: expeditionPlayers.sessionId,
      senderId: expeditionPlayers.senderId,
    }).from(expeditionPlayers),
    db.select({
      sessionId: expeditionReports.sessionId,
      senderId: expeditionReports.senderId,
    }).from(expeditionReports),
  ]);

  entryRows.forEach(add);
  playerRows.forEach(add);
  reportRows.forEach(add);

  return [...senderKeys.values()].sort((left, right) => {
    const sessionOrder = left.sessionId.localeCompare(right.sessionId);
    return sessionOrder !== 0 ? sessionOrder : left.senderId.localeCompare(right.senderId);
  });
}

async function repairSenderName(
  db: PostgresStore["db"],
  senderKey: SenderKey,
  senderName: string,
): Promise<{
  entries: number;
  players: number;
  reports: number;
}> {
  const now = new Date();
  const [entryRows, playerRows, reportRows] = await Promise.all([
    db.update(expeditionEntries)
      .set({
        senderName,
        updatedAt: now,
      })
      .where(
        and(
          eq(expeditionEntries.sessionId, senderKey.sessionId),
          eq(expeditionEntries.senderId, senderKey.senderId),
        ),
      )
      .returning({ id: expeditionEntries.id }),
    db.update(expeditionPlayers)
      .set({
        senderName,
        updatedAt: now,
      })
      .where(
        and(
          eq(expeditionPlayers.sessionId, senderKey.sessionId),
          eq(expeditionPlayers.senderId, senderKey.senderId),
        ),
      )
      .returning({ id: expeditionPlayers.id }),
    db.update(expeditionReports)
      .set({ senderName })
      .where(
        and(
          eq(expeditionReports.sessionId, senderKey.sessionId),
          eq(expeditionReports.senderId, senderKey.senderId),
        ),
      )
      .returning({ id: expeditionReports.id }),
  ]);

  return {
    entries: entryRows.length,
    players: playerRows.length,
    reports: reportRows.length,
  };
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
