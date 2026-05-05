import { and, eq, sql } from "drizzle-orm";
import type {
  PluginOperationRunLookup,
  PluginOperationRunRecord,
  PluginOperationRunScope,
  PluginOperationRunStatus,
  PluginOperationRunStore as PluginOperationRunStoreContract,
  StartPluginOperationRunInput,
  StartPluginOperationRunResult,
} from "../../plugins/types.js";
import type { GatewayDatabase, GatewayTransaction } from "../client.js";
import type { JsonValue } from "../json.js";
import { pluginOperationRuns } from "../schema/index.js";

type PluginOperationRunExecutor = GatewayDatabase | GatewayTransaction;

interface NormalizedStartPluginOperationRunInput {
  pluginId: string;
  scope: PluginOperationRunScope;
  scopeId: string;
  operationKey: string;
  metadata?: JsonValue;
  retryFailed: boolean;
}

interface NormalizedPluginOperationRunLookup {
  pluginId: string;
  scope: PluginOperationRunScope;
  scopeId: string;
  operationKey: string;
}

export class PostgresPluginOperationRunStore implements PluginOperationRunStoreContract {
  public constructor(private readonly db: GatewayDatabase) {}

  public async tryStart(
    input: StartPluginOperationRunInput,
  ): Promise<StartPluginOperationRunResult> {
    const normalized = normalizeStartInput(input);

    return this.db.transaction(async (tx) => {
      const now = new Date();
      const insertedRows = await tx
        .insert(pluginOperationRuns)
        .values({
          pluginId: normalized.pluginId,
          scope: normalized.scope,
          scopeId: normalized.scopeId,
          operationKey: normalized.operationKey,
          status: "running",
          attempts: 1,
          metadata: normalized.metadata,
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [
            pluginOperationRuns.pluginId,
            pluginOperationRuns.scope,
            pluginOperationRuns.scopeId,
            pluginOperationRuns.operationKey,
          ],
        })
        .returning();

      const inserted = insertedRows[0];
      if (inserted) {
        return {
          started: true,
          run: toRecord(inserted),
        };
      }

      const existing = await this.findUsing(tx, normalized);
      if (!existing) {
        throw new Error("插件操作运行记录创建失败，且未找到已有记录");
      }

      if (existing.status === "failed" && normalized.retryFailed) {
        const restarted = await this.restartFailedRun(tx, existing, normalized.metadata);
        if (restarted) {
          return {
            started: true,
            run: restarted,
            previousStatus: existing.status,
          };
        }

        const latest = await this.findByIdUsing(tx, existing.id);
        if (!latest) {
          throw new Error(`插件操作运行记录不存在：${existing.id}`);
        }

        return {
          started: false,
          run: latest,
          previousStatus: latest.status,
        };
      }

      return {
        started: false,
        run: existing,
        previousStatus: existing.status,
      };
    });
  }

  public async markSucceeded(
    id: number,
    metadata?: JsonValue,
  ): Promise<PluginOperationRunRecord> {
    const now = new Date();
    const values = {
      status: "succeeded",
      ...(metadata !== undefined ? { metadata } : {}),
      errorMessage: null,
      finishedAt: now,
      updatedAt: now,
    } as const;

    const rows = await this.db
      .update(pluginOperationRuns)
      .set(values)
      .where(eq(pluginOperationRuns.id, id))
      .returning();

    return requireRun(rows[0], id);
  }

  public async markFailed(
    id: number,
    error: unknown,
    metadata?: JsonValue,
  ): Promise<PluginOperationRunRecord> {
    const now = new Date();
    const values = {
      status: "failed",
      ...(metadata !== undefined ? { metadata } : {}),
      errorMessage: errorToMessage(error),
      finishedAt: now,
      updatedAt: now,
    } as const;

    const rows = await this.db
      .update(pluginOperationRuns)
      .set(values)
      .where(eq(pluginOperationRuns.id, id))
      .returning();

    return requireRun(rows[0], id);
  }

  public async get(input: PluginOperationRunLookup): Promise<PluginOperationRunRecord | null> {
    return this.findUsing(this.db, normalizeLookup(input));
  }

  private async restartFailedRun(
    tx: GatewayTransaction,
    existing: PluginOperationRunRecord,
    metadata: JsonValue | undefined,
  ): Promise<PluginOperationRunRecord | null> {
    const now = new Date();
    const values = {
      status: "running",
      attempts: sql`${pluginOperationRuns.attempts} + 1`,
      ...(metadata !== undefined ? { metadata } : {}),
      errorMessage: null,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    } as const;

    const rows = await tx
      .update(pluginOperationRuns)
      .set(values)
      .where(
        and(
          eq(pluginOperationRuns.id, existing.id),
          eq(pluginOperationRuns.status, "failed"),
        ),
      )
      .returning();

    return rows[0] ? toRecord(rows[0]) : null;
  }

  private async findUsing(
    executor: PluginOperationRunExecutor,
    input: NormalizedPluginOperationRunLookup,
  ): Promise<PluginOperationRunRecord | null> {
    const rows = await executor
      .select()
      .from(pluginOperationRuns)
      .where(
        and(
          eq(pluginOperationRuns.pluginId, input.pluginId),
          eq(pluginOperationRuns.scope, input.scope),
          eq(pluginOperationRuns.scopeId, input.scopeId),
          eq(pluginOperationRuns.operationKey, input.operationKey),
        ),
      )
      .limit(1);

    return rows[0] ? toRecord(rows[0]) : null;
  }

  private async findByIdUsing(
    executor: PluginOperationRunExecutor,
    id: number,
  ): Promise<PluginOperationRunRecord | null> {
    const rows = await executor
      .select()
      .from(pluginOperationRuns)
      .where(eq(pluginOperationRuns.id, id))
      .limit(1);

    return rows[0] ? toRecord(rows[0]) : null;
  }
}

function normalizeStartInput(
  input: StartPluginOperationRunInput,
): NormalizedStartPluginOperationRunInput {
  return {
    pluginId: normalizeRequiredText(input.pluginId, "pluginId"),
    scope: normalizeScope(input.scope),
    scopeId: normalizeScopeId(input.scope, input.scopeId),
    operationKey: normalizeRequiredText(input.operationKey, "operationKey"),
    metadata: input.metadata,
    retryFailed: Boolean(input.retryFailed),
  };
}

function normalizeLookup(input: PluginOperationRunLookup): NormalizedPluginOperationRunLookup {
  return {
    pluginId: normalizeRequiredText(input.pluginId, "pluginId"),
    scope: normalizeScope(input.scope),
    scopeId: normalizeScopeId(input.scope, input.scopeId),
    operationKey: normalizeRequiredText(input.operationKey, "operationKey"),
  };
}

function normalizeScope(scope: PluginOperationRunScope): PluginOperationRunScope {
  if (scope !== "global" && scope !== "session" && scope !== "sender") {
    throw new Error(`不支持的插件操作 scope：${scope}`);
  }

  return scope;
}

function normalizeScopeId(scope: PluginOperationRunScope, scopeId: string | undefined): string {
  if (scope === "global") {
    return "global";
  }

  return normalizeRequiredText(scopeId ?? "", "scopeId");
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} 不能为空`);
  }

  return normalized;
}

function toRecord(row: typeof pluginOperationRuns.$inferSelect): PluginOperationRunRecord {
  return {
    id: row.id,
    pluginId: row.pluginId,
    scope: row.scope as PluginOperationRunScope,
    scopeId: row.scopeId,
    operationKey: row.operationKey,
    status: row.status as PluginOperationRunStatus,
    attempts: row.attempts,
    metadata: row.metadata ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireRun(
  row: typeof pluginOperationRuns.$inferSelect | undefined,
  id: number,
): PluginOperationRunRecord {
  if (!row) {
    throw new Error(`插件操作运行记录不存在：${id}`);
  }

  return toRecord(row);
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
