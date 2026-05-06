import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { GatewayDatabase } from "../db/client.js";
import { gatewaySessions, pluginSessionStates } from "../db/schema/index.js";
import type {
  PluginEnabledSession,
  PluginStateStore as PluginStateStoreContract,
} from "./types.js";

export class PostgresPluginStateStore implements PluginStateStoreContract {
  public constructor(private readonly db: GatewayDatabase) {}

  public async isEnabled(
    sessionId: string,
    pluginId: string,
    defaultEnabled = true,
  ): Promise<boolean> {
    const rows = await this.db
      .select({
        enabled: pluginSessionStates.enabled,
      })
      .from(pluginSessionStates)
      .where(
        and(
          eq(pluginSessionStates.sessionId, sessionId),
          eq(pluginSessionStates.pluginId, pluginId),
        ),
      )
      .limit(1);

    return rows[0]?.enabled ?? defaultEnabled;
  }

  public async setEnabled(sessionId: string, pluginId: string, enabled: boolean): Promise<void> {
    const now = new Date();
    await this.db
      .insert(gatewaySessions)
      .values({
        sessionId,
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: gatewaySessions.sessionId,
      });

    await this.db
      .insert(pluginSessionStates)
      .values({
        pluginId,
        sessionId,
        enabled,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [pluginSessionStates.pluginId, pluginSessionStates.sessionId],
        set: {
          enabled,
          updatedAt: now,
        },
      });
  }

  public async listEnabledSessions(
    pluginId: string,
    defaultEnabled = true,
  ): Promise<PluginEnabledSession[]> {
    const enabledCondition = defaultEnabled
      ? or(isNull(pluginSessionStates.enabled), eq(pluginSessionStates.enabled, true))
      : eq(pluginSessionStates.enabled, true);

    const rows = await this.db
      .select({
        sessionId: gatewaySessions.sessionId,
        groupName: gatewaySessions.groupName,
        lastSeenAt: gatewaySessions.lastSeenAt,
      })
      .from(gatewaySessions)
      .leftJoin(
        pluginSessionStates,
        and(
          eq(pluginSessionStates.sessionId, gatewaySessions.sessionId),
          eq(pluginSessionStates.pluginId, pluginId),
        ),
      )
      .where(enabledCondition)
      .orderBy(desc(gatewaySessions.lastSeenAt));

    return rows.map((row) => ({
      sessionId: row.sessionId,
      groupName: row.groupName ?? undefined,
      lastSeenAt: row.lastSeenAt,
    }));
  }
}
