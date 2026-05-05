import { and, asc, eq, like } from "drizzle-orm";
import type { PluginDataStore as PluginDataStoreContract } from "../../plugins/types.js";
import type { JsonValue } from "../json.js";
import type { GatewayDatabase } from "../client.js";
import { pluginKv } from "../schema/index.js";

export class PostgresPluginDataStore implements PluginDataStoreContract {
  public constructor(private readonly db: GatewayDatabase) {}

  public async getValue<T extends JsonValue = JsonValue>(
    pluginId: string,
    sessionId: string,
    key: string,
  ): Promise<T | null> {
    const rows = await this.db
      .select({
        value: pluginKv.value,
      })
      .from(pluginKv)
      .where(
        and(
          eq(pluginKv.pluginId, pluginId),
          eq(pluginKv.sessionId, sessionId),
          eq(pluginKv.key, key),
        ),
      )
      .limit(1);

    return (rows[0]?.value as T | undefined) ?? null;
  }

  public async setValue(
    pluginId: string,
    sessionId: string,
    key: string,
    value: JsonValue,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(pluginKv)
      .values({
        pluginId,
        sessionId,
        key,
        value,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [pluginKv.pluginId, pluginKv.sessionId, pluginKv.key],
        set: {
          value,
          updatedAt: now,
        },
      });
  }

  public async deleteValue(pluginId: string, sessionId: string, key: string): Promise<void> {
    await this.db
      .delete(pluginKv)
      .where(
        and(
          eq(pluginKv.pluginId, pluginId),
          eq(pluginKv.sessionId, sessionId),
          eq(pluginKv.key, key),
        ),
      );
  }

  public async listKeys(
    pluginId: string,
    sessionId: string,
    keyPrefix?: string,
  ): Promise<string[]> {
    const conditions = [
      eq(pluginKv.pluginId, pluginId),
      eq(pluginKv.sessionId, sessionId),
    ];

    if (keyPrefix) {
      conditions.push(like(pluginKv.key, `${escapeLikePattern(keyPrefix)}%`));
    }

    const rows = await this.db
      .select({
        key: pluginKv.key,
      })
      .from(pluginKv)
      .where(and(...conditions))
      .orderBy(asc(pluginKv.key));

    return rows.map((row) => row.key);
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
