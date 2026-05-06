import { desc, sql } from "drizzle-orm";
import type { GatewayDatabase } from "../client.js";
import { gatewaySessions } from "../schema/index.js";

export interface GatewaySessionRecord {
  sessionId: string;
  groupName?: string;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertGatewaySessionInput {
  sessionId: string;
  groupName?: string;
  lastSeenAt?: Date;
}

export class GatewaySessionStore {
  public constructor(private readonly db: GatewayDatabase) {}

  public async upsertSeen(input: UpsertGatewaySessionInput): Promise<GatewaySessionRecord> {
    const now = new Date();
    const lastSeenAt = input.lastSeenAt ?? now;
    const rows = await this.db
      .insert(gatewaySessions)
      .values({
        sessionId: input.sessionId,
        groupName: input.groupName,
        lastSeenAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: gatewaySessions.sessionId,
        set: {
          groupName: sql`coalesce(excluded.group_name, ${gatewaySessions.groupName})`,
          lastSeenAt,
          updatedAt: now,
        },
      })
      .returning();

    return toRecord(rows[0]!);
  }

  public async listRecent(limit = 100): Promise<GatewaySessionRecord[]> {
    const rows = await this.db
      .select()
      .from(gatewaySessions)
      .orderBy(desc(gatewaySessions.lastSeenAt))
      .limit(Math.max(1, limit));

    return rows.map(toRecord);
  }
}

function toRecord(row: typeof gatewaySessions.$inferSelect): GatewaySessionRecord {
  return {
    sessionId: row.sessionId,
    groupName: row.groupName ?? undefined,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
