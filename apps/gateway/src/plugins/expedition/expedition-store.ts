import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { GatewayDatabase, GatewayTransaction } from "../../db/client.js";
import type { JsonValue } from "../../db/json.js";
import {
  expeditionEntries,
  expeditionPlayers,
  expeditionRelics,
  expeditionReports,
  expeditionWorlds,
} from "./expedition-schema.js";
import type {
  ExpeditionEntryPlan,
  ExpeditionEntryRecord,
  ExpeditionEntryStatus,
  ExpeditionOutcome,
  ExpeditionPlayerRecord,
  ExpeditionRankingRecord,
  ExpeditionRelicEffectValue,
  ExpeditionRelicRecord,
  ExpeditionReportRecord,
  ExpeditionSettlementSummary,
  ExpeditionStrategy,
  ExpeditionWorldRecord,
} from "./expedition-types.js";

type ExpeditionExecutor = GatewayDatabase | GatewayTransaction;

export class ExpeditionStore {
  public constructor(
    private readonly db: GatewayDatabase,
    private readonly tx?: GatewayTransaction,
  ) {}

  public withTransaction(tx: GatewayTransaction): ExpeditionStore {
    return new ExpeditionStore(this.db, tx);
  }

  public async findEntry(
    sessionId: string,
    dateKey: string,
    senderId: string,
  ): Promise<ExpeditionEntryRecord | null> {
    const rows = await this.executor()
      .select()
      .from(expeditionEntries)
      .where(
        and(
          eq(expeditionEntries.sessionId, sessionId),
          eq(expeditionEntries.dateKey, dateKey),
          eq(expeditionEntries.senderId, senderId),
        ),
      )
      .limit(1);

    return rows[0] ? toEntryRecord(rows[0]) : null;
  }

  public async createEntry(input: {
    sessionId: string;
    groupName?: string;
    senderId: string;
    senderName: string;
    dateKey: string;
    plan: ExpeditionEntryPlan;
  }): Promise<ExpeditionEntryRecord> {
    const now = new Date();
    const rows = await this.executor()
      .insert(expeditionEntries)
      .values({
        sessionId: input.sessionId,
        groupName: input.groupName,
        senderId: input.senderId,
        senderName: input.senderName,
        dateKey: input.dateKey,
        strategy: input.plan.strategy,
        stake: input.plan.stake,
        allIn: input.plan.allIn,
        boosted: false,
        boostStake: 0,
        boostedAt: null,
        status: "registered",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireEntry(rows[0]);
  }

  public async updateEntryPlan(
    entry: ExpeditionEntryRecord,
    input: {
      groupName?: string;
      senderName: string;
      plan: ExpeditionEntryPlan;
    },
  ): Promise<ExpeditionEntryRecord> {
    const now = new Date();
    const rows = await this.executor()
      .update(expeditionEntries)
      .set({
        groupName: input.groupName,
        senderName: input.senderName,
        strategy: input.plan.strategy,
        stake: input.plan.stake,
        allIn: input.plan.allIn,
        boosted: false,
        boostStake: 0,
        boostedAt: null,
        status: "registered",
        revision: entry.revision + 1,
        updatedAt: now,
        settledAt: null,
      })
      .where(eq(expeditionEntries.id, entry.id))
      .returning();

    return requireEntry(rows[0]);
  }

  public async boostEntry(
    entry: ExpeditionEntryRecord,
    boostStake: number,
  ): Promise<ExpeditionEntryRecord> {
    const now = new Date();
    const rows = await this.executor()
      .update(expeditionEntries)
      .set({
        stake: entry.stake + boostStake,
        boosted: true,
        boostStake,
        boostedAt: now,
        revision: entry.revision + 1,
        updatedAt: now,
      })
      .where(eq(expeditionEntries.id, entry.id))
      .returning();

    return requireEntry(rows[0]);
  }

  public async cancelEntry(entry: ExpeditionEntryRecord): Promise<ExpeditionEntryRecord> {
    const now = new Date();
    const rows = await this.executor()
      .update(expeditionEntries)
      .set({
        status: "cancelled",
        updatedAt: now,
      })
      .where(eq(expeditionEntries.id, entry.id))
      .returning();

    return requireEntry(rows[0]);
  }

  public async markEntrySettled(entryId: number): Promise<void> {
    const now = new Date();
    await this.executor()
      .update(expeditionEntries)
      .set({
        status: "settled",
        settledAt: now,
        updatedAt: now,
      })
      .where(eq(expeditionEntries.id, entryId));
  }

  public async listRegisteredSessions(dateKey: string): Promise<Array<{
    sessionId: string;
    groupName?: string;
  }>> {
    const rows = await this.executor()
      .selectDistinct({
        sessionId: expeditionEntries.sessionId,
        groupName: expeditionEntries.groupName,
      })
      .from(expeditionEntries)
      .where(
        and(
          eq(expeditionEntries.dateKey, dateKey),
          eq(expeditionEntries.status, "registered"),
        ),
      )
      .orderBy(asc(expeditionEntries.sessionId));

    return rows.map((row) => ({
      sessionId: row.sessionId,
      groupName: row.groupName ?? undefined,
    }));
  }

  public async listRegisteredEntries(
    sessionId: string,
    dateKey: string,
  ): Promise<ExpeditionEntryRecord[]> {
    const rows = await this.executor()
      .select()
      .from(expeditionEntries)
      .where(
        and(
          eq(expeditionEntries.sessionId, sessionId),
          eq(expeditionEntries.dateKey, dateKey),
          eq(expeditionEntries.status, "registered"),
        ),
      )
      .orderBy(asc(expeditionEntries.createdAt));

    return rows.map(toEntryRecord);
  }

  public async getOrCreatePlayer(input: {
    sessionId: string;
    senderId: string;
    senderName: string;
  }): Promise<ExpeditionPlayerRecord> {
    const now = new Date();
    const insertedRows = await this.executor()
      .insert(expeditionPlayers)
      .values({
        sessionId: input.sessionId,
        senderId: input.senderId,
        senderName: input.senderName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [expeditionPlayers.sessionId, expeditionPlayers.senderId],
      })
      .returning();

    const inserted = insertedRows[0];
    if (inserted) {
      return toPlayerRecord(inserted);
    }

    const rows = await this.executor()
      .select()
      .from(expeditionPlayers)
      .where(
        and(
          eq(expeditionPlayers.sessionId, input.sessionId),
          eq(expeditionPlayers.senderId, input.senderId),
        ),
      )
      .limit(1);

    const existing = rows[0];
    if (!existing) {
      throw new Error("远征玩家状态创建失败，且未找到已有状态");
    }

    return toPlayerRecord(existing);
  }

  public async updatePlayerAfterSettlement(input: {
    sessionId: string;
    senderId: string;
    senderName: string;
    survived: boolean;
    finalDepth: number;
    purification: number;
  }): Promise<void> {
    const now = new Date();
    const currentDepth = input.survived ? input.finalDepth : 0;
    const runHighDepth = input.survived ? input.finalDepth : 0;
    const totalPurification = input.survived ? sql`${expeditionPlayers.totalPurification} + ${input.purification}` : 0;

    await this.executor()
      .update(expeditionPlayers)
      .set({
        senderName: input.senderName,
        currentDepth,
        runHighDepth,
        totalPurification,
        updatedAt: now,
      })
      .where(
        and(
          eq(expeditionPlayers.sessionId, input.sessionId),
          eq(expeditionPlayers.senderId, input.senderId),
        ),
      );
  }

  public async listActiveRelics(
    sessionId: string,
    senderId: string,
  ): Promise<ExpeditionRelicRecord[]> {
    const rows = await this.executor()
      .select()
      .from(expeditionRelics)
      .where(
        and(
          eq(expeditionRelics.sessionId, sessionId),
          eq(expeditionRelics.senderId, senderId),
          eq(expeditionRelics.active, true),
        ),
      )
      .orderBy(asc(expeditionRelics.createdAt));

    return rows.map(toRelicRecord);
  }

  public async listRecentActiveRelics(
    sessionId: string,
    senderId: string,
    limit: number,
  ): Promise<ExpeditionRelicRecord[]> {
    const rows = await this.executor()
      .select()
      .from(expeditionRelics)
      .where(
        and(
          eq(expeditionRelics.sessionId, sessionId),
          eq(expeditionRelics.senderId, senderId),
          eq(expeditionRelics.active, true),
        ),
      )
      .orderBy(desc(expeditionRelics.createdAt))
      .limit(limit);

    return rows.map(toRelicRecord);
  }

  public async insertRelic(input: {
    sessionId: string;
    senderId: string;
    name: string;
    rarity: string;
    effectType: string;
    effectValue: ExpeditionRelicEffectValue;
    description: string;
    acquiredDateKey: string;
  }): Promise<ExpeditionRelicRecord> {
    const now = new Date();
    const rows = await this.executor()
      .insert(expeditionRelics)
      .values({
        ...input,
        effectValue: input.effectValue as JsonValue,
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireRelic(rows[0]);
  }

  public async deactivateActiveRelics(sessionId: string, senderId: string): Promise<void> {
    await this.executor()
      .update(expeditionRelics)
      .set({
        active: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(expeditionRelics.sessionId, sessionId),
          eq(expeditionRelics.senderId, senderId),
          eq(expeditionRelics.active, true),
        ),
      );
  }

  public async getOrCreateWorld(
    sessionId: string,
    groupName: string | undefined,
    bossName: string,
  ): Promise<ExpeditionWorldRecord> {
    const now = new Date();
    const insertedRows = await this.executor()
      .insert(expeditionWorlds)
      .values({
        sessionId,
        groupName,
        bossName,
        bossMaxPollution: 1_000_000,
        bossPollution: 1_000_000,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: expeditionWorlds.sessionId,
      })
      .returning();

    const inserted = insertedRows[0];
    if (inserted) {
      return toWorldRecord(inserted);
    }

    const rows = await this.executor()
      .select()
      .from(expeditionWorlds)
      .where(eq(expeditionWorlds.sessionId, sessionId))
      .limit(1);

    const existing = rows[0];
    if (!existing) {
      throw new Error("远征世界状态创建失败，且未找到已有状态");
    }

    return toWorldRecord(existing);
  }

  public async updateWorldAfterSettlement(input: {
    sessionId: string;
    groupName?: string;
    bossName: string;
    bossMaxPollution: number;
    bossPollution: number;
  }): Promise<ExpeditionWorldRecord> {
    const rows = await this.executor()
      .update(expeditionWorlds)
      .set({
        groupName: input.groupName,
        bossName: input.bossName,
        bossMaxPollution: input.bossMaxPollution,
        bossPollution: input.bossPollution,
        updatedAt: new Date(),
      })
      .where(eq(expeditionWorlds.sessionId, input.sessionId))
      .returning();

    return requireWorld(rows[0]);
  }

  public async insertReport(input: Omit<ExpeditionReportRecord, "id" | "createdAt">): Promise<void> {
    await this.executor()
      .insert(expeditionReports)
      .values({
        sessionId: input.sessionId,
        groupName: input.groupName,
        dateKey: input.dateKey,
        senderId: input.senderId,
        senderName: input.senderName,
        strategy: input.strategy,
        stake: input.stake,
        outcome: input.outcome,
        startDepth: input.startDepth,
        targetDepth: input.targetDepth,
        finalDepth: input.finalDepth,
        survivalRateBasisPoints: input.survivalRateBasisPoints,
        multiplierBasisPoints: input.multiplierBasisPoints,
        boosted: input.boosted,
        boostStake: input.boostStake,
        rewardPoints: input.rewardPoints,
        lostPoints: input.lostPoints,
        purification: input.purification,
        deathReason: input.deathReason,
        relicName: input.relicName,
        relicRarity: input.relicRarity,
        specialEventText: input.specialEventText,
        details: input.details,
      })
      .onConflictDoNothing({
        target: [
          expeditionReports.sessionId,
          expeditionReports.dateKey,
          expeditionReports.senderId,
        ],
      });
  }

  public async getReport(
    sessionId: string,
    dateKey: string,
    senderId: string,
  ): Promise<ExpeditionReportRecord | null> {
    const rows = await this.executor()
      .select()
      .from(expeditionReports)
      .where(
        and(
          eq(expeditionReports.sessionId, sessionId),
          eq(expeditionReports.dateKey, dateKey),
          eq(expeditionReports.senderId, senderId),
        ),
      )
      .limit(1);

    return rows[0] ? toReportRecord(rows[0]) : null;
  }

  public async listReports(
    sessionId: string,
    dateKey: string,
  ): Promise<ExpeditionReportRecord[]> {
    const rows = await this.executor()
      .select()
      .from(expeditionReports)
      .where(
        and(
          eq(expeditionReports.sessionId, sessionId),
          eq(expeditionReports.dateKey, dateKey),
        ),
      );

    return rows.map(toReportRecord);
  }

  public async listRanking(sessionId: string, limit: number): Promise<ExpeditionRankingRecord[]> {
    const rows = await this.executor()
      .select({
        senderId: expeditionPlayers.senderId,
        senderName: expeditionPlayers.senderName,
        currentDepth: expeditionPlayers.currentDepth,
      })
      .from(expeditionPlayers)
      .where(
        and(
          eq(expeditionPlayers.sessionId, sessionId),
          gt(expeditionPlayers.currentDepth, 0),
        ),
      )
      .orderBy(desc(expeditionPlayers.currentDepth), asc(expeditionPlayers.senderName))
      .limit(limit);

    return rows;
  }

  private executor(): ExpeditionExecutor {
    return this.tx ?? this.db;
  }
}

export function toAnnouncementSummary(
  input: Omit<ExpeditionSettlementSummary, "announcementText"> & { announcementText: string },
): ExpeditionSettlementSummary {
  return input;
}

function requireEntry(row: typeof expeditionEntries.$inferSelect | undefined): ExpeditionEntryRecord {
  if (!row) {
    throw new Error("远征报名记录写入失败");
  }

  return toEntryRecord(row);
}

function requireRelic(row: typeof expeditionRelics.$inferSelect | undefined): ExpeditionRelicRecord {
  if (!row) {
    throw new Error("远征遗物记录写入失败");
  }

  return toRelicRecord(row);
}

function requireWorld(row: typeof expeditionWorlds.$inferSelect | undefined): ExpeditionWorldRecord {
  if (!row) {
    throw new Error("远征世界状态写入失败");
  }

  return toWorldRecord(row);
}

function toEntryRecord(row: typeof expeditionEntries.$inferSelect): ExpeditionEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    groupName: row.groupName ?? undefined,
    senderId: row.senderId,
    senderName: row.senderName,
    dateKey: row.dateKey,
    strategy: row.strategy as ExpeditionStrategy,
    stake: row.stake,
    allIn: row.allIn,
    boosted: row.boosted,
    boostStake: row.boostStake,
    boostedAt: row.boostedAt ?? undefined,
    status: row.status as ExpeditionEntryStatus,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    settledAt: row.settledAt ?? undefined,
  };
}

function toPlayerRecord(row: typeof expeditionPlayers.$inferSelect): ExpeditionPlayerRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    senderId: row.senderId,
    senderName: row.senderName,
    currentDepth: row.currentDepth,
    runHighDepth: row.runHighDepth,
    totalPurification: row.totalPurification,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRelicRecord(row: typeof expeditionRelics.$inferSelect): ExpeditionRelicRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    senderId: row.senderId,
    name: row.name,
    rarity: row.rarity as ExpeditionRelicRecord["rarity"],
    effectType: row.effectType as ExpeditionRelicRecord["effectType"],
    effectValue: row.effectValue as ExpeditionRelicEffectValue,
    description: row.description,
    acquiredDateKey: row.acquiredDateKey,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorldRecord(row: typeof expeditionWorlds.$inferSelect): ExpeditionWorldRecord {
  return {
    sessionId: row.sessionId,
    groupName: row.groupName ?? undefined,
    bossName: row.bossName,
    bossMaxPollution: row.bossMaxPollution,
    bossPollution: row.bossPollution,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toReportRecord(row: typeof expeditionReports.$inferSelect): ExpeditionReportRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    groupName: row.groupName ?? undefined,
    dateKey: row.dateKey,
    senderId: row.senderId,
    senderName: row.senderName,
    strategy: row.strategy as ExpeditionStrategy,
    stake: row.stake,
    outcome: row.outcome as ExpeditionOutcome,
    startDepth: row.startDepth,
    targetDepth: row.targetDepth,
    finalDepth: row.finalDepth,
    survivalRateBasisPoints: row.survivalRateBasisPoints,
    multiplierBasisPoints: row.multiplierBasisPoints,
    boosted: row.boosted,
    boostStake: row.boostStake,
    rewardPoints: row.rewardPoints,
    lostPoints: row.lostPoints,
    purification: row.purification,
    deathReason: row.deathReason ?? undefined,
    relicName: row.relicName ?? undefined,
    relicRarity: (row.relicRarity as ExpeditionReportRecord["relicRarity"]) ?? undefined,
    specialEventText: row.specialEventText ?? undefined,
    details: row.details ?? undefined,
    createdAt: row.createdAt,
  };
}
