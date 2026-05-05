import { and, eq } from "drizzle-orm";
import type { GatewayDatabase, GatewayTransaction } from "../../db/client.js";
import { checkinRecords } from "./checkin-schema.js";

type CheckinExecutor = GatewayDatabase | GatewayTransaction;

export interface CheckinRecord {
  id: number;
  sessionId: string;
  senderId: string;
  senderName: string;
  dateKey: string;
  reward: number;
  createdAt: Date;
}

export interface CreateCheckinInput {
  sessionId: string;
  senderId: string;
  senderName: string;
  dateKey: string;
  reward: number;
}

export interface CreateCheckinResult {
  created: boolean;
  record: CheckinRecord;
}

export class CheckinStore {
  public constructor(
    private readonly db: GatewayDatabase,
    private readonly tx?: GatewayTransaction,
  ) {}

  public withTransaction(tx: GatewayTransaction): CheckinStore {
    return new CheckinStore(this.db, tx);
  }

  public async findByDailySender(
    sessionId: string,
    senderId: string,
    dateKey: string,
  ): Promise<CheckinRecord | null> {
    const rows = await this.executor()
      .select()
      .from(checkinRecords)
      .where(
        and(
          eq(checkinRecords.sessionId, sessionId),
          eq(checkinRecords.senderId, senderId),
          eq(checkinRecords.dateKey, dateKey),
        ),
      )
      .limit(1);

    return rows[0] ? toRecord(rows[0]) : null;
  }

  public async createDailyCheckin(input: CreateCheckinInput): Promise<CreateCheckinResult> {
    const rows = await this.executor()
      .insert(checkinRecords)
      .values(input)
      .onConflictDoNothing({
        target: [
          checkinRecords.sessionId,
          checkinRecords.senderId,
          checkinRecords.dateKey,
        ],
      })
      .returning();

    const inserted = rows[0];
    if (inserted) {
      return {
        created: true,
        record: toRecord(inserted),
      };
    }

    const existing = await this.findByDailySender(input.sessionId, input.senderId, input.dateKey);
    if (!existing) {
      throw new Error("签到记录创建失败，且未找到已有记录");
    }

    return {
      created: false,
      record: existing,
    };
  }

  private executor(): CheckinExecutor {
    return this.tx ?? this.db;
  }
}

function toRecord(row: typeof checkinRecords.$inferSelect): CheckinRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    senderId: row.senderId,
    senderName: row.senderName,
    dateKey: row.dateKey,
    reward: row.reward,
    createdAt: row.createdAt,
  };
}
