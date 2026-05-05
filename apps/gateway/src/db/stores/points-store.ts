import { and, eq, sql } from "drizzle-orm";
import type { JsonValue } from "../json.js";
import type { GatewayDatabase, GatewayTransaction } from "../client.js";
import { pointsAccounts, pointsLedger } from "../schema/index.js";

type PointsExecutor = GatewayDatabase | GatewayTransaction;

export interface PointsAccountRecord {
  id: number;
  sessionId: string;
  senderId: string;
  balance: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PointsLedgerRecord {
  id: number;
  sessionId: string;
  senderId: string;
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
  source: string;
  description: string;
  operatorId?: string;
  idempotencyKey?: string;
  metadata?: JsonValue;
  createdAt: Date;
}

export interface CreateInitialPointsAccountInput {
  sessionId: string;
  senderId: string;
  initialBalance: number;
  source: string;
  description: string;
  operatorId?: string;
  idempotencyKey?: string;
  metadata?: JsonValue;
}

export interface ChangePointsBalanceInput {
  sessionId: string;
  senderId: string;
  delta: number;
  source: string;
  description: string;
  operatorId?: string;
  idempotencyKey?: string;
  metadata?: JsonValue;
}

export class PointsStore {
  public constructor(
    private readonly db: GatewayDatabase,
    private readonly tx?: GatewayTransaction,
  ) {}

  public withTransaction(tx: GatewayTransaction): PointsStore {
    return new PointsStore(this.db, tx);
  }

  public async findAccount(
    sessionId: string,
    senderId: string,
  ): Promise<PointsAccountRecord | null> {
    return this.findAccountUsing(this.executor(), sessionId, senderId);
  }

  public async findLedgerByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PointsLedgerRecord | null> {
    return this.findLedgerByIdempotencyKeyUsing(this.executor(), idempotencyKey);
  }

  private async findAccountUsing(
    executor: PointsExecutor,
    sessionId: string,
    senderId: string,
  ): Promise<PointsAccountRecord | null> {
    const rows = await executor
      .select()
      .from(pointsAccounts)
      .where(
        and(
          eq(pointsAccounts.sessionId, sessionId),
          eq(pointsAccounts.senderId, senderId),
        ),
      )
      .limit(1);

    return rows[0] ? toAccountRecord(rows[0]) : null;
  }

  private async findLedgerByIdempotencyKeyUsing(
    executor: PointsExecutor,
    idempotencyKey: string,
  ): Promise<PointsLedgerRecord | null> {
    const rows = await executor
      .select()
      .from(pointsLedger)
      .where(eq(pointsLedger.idempotencyKey, idempotencyKey))
      .limit(1);

    return rows[0] ? toLedgerRecord(rows[0]) : null;
  }

  public async createInitialAccount(
    input: CreateInitialPointsAccountInput,
  ): Promise<PointsAccountRecord> {
    return this.withWriteTransaction(async (tx) => {
      const insertedRows = await tx
        .insert(pointsAccounts)
        .values({
          sessionId: input.sessionId,
          senderId: input.senderId,
          balance: input.initialBalance,
        })
        .onConflictDoNothing({
          target: [pointsAccounts.sessionId, pointsAccounts.senderId],
        })
        .returning();

      const insertedAccount = insertedRows[0];
      if (insertedAccount) {
        await tx.insert(pointsLedger).values({
          sessionId: input.sessionId,
          senderId: input.senderId,
          delta: input.initialBalance,
          balanceBefore: 0,
          balanceAfter: input.initialBalance,
          source: input.source,
          description: input.description,
          operatorId: input.operatorId,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        });

        return toAccountRecord(insertedAccount);
      }

      const existingRows = await tx
        .select()
        .from(pointsAccounts)
        .where(
          and(
            eq(pointsAccounts.sessionId, input.sessionId),
            eq(pointsAccounts.senderId, input.senderId),
          ),
        )
        .limit(1);

      const existingAccount = existingRows[0];
      if (!existingAccount) {
        throw new Error("积分账户创建失败，且未找到已有账户");
      }

      return toAccountRecord(existingAccount);
    });
  }

  public async changeBalance(input: ChangePointsBalanceInput): Promise<PointsLedgerRecord> {
    return this.withWriteTransaction(async (tx) => {
      if (input.idempotencyKey) {
        await lockIdempotencyKey(tx, input.idempotencyKey);
        const existingLedger = await this.findLedgerByIdempotencyKeyUsing(
          tx,
          input.idempotencyKey,
        );
        if (existingLedger) {
          assertLedgerMatchesInput(existingLedger, input);
          return existingLedger;
        }
      }

      const updatedRows = await tx
        .update(pointsAccounts)
        .set({
          balance: sql`${pointsAccounts.balance} + ${input.delta}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pointsAccounts.sessionId, input.sessionId),
            eq(pointsAccounts.senderId, input.senderId),
            sql`${pointsAccounts.balance} + ${input.delta} >= 0`,
          ),
        )
        .returning({
          balanceBefore: sql<number>`${pointsAccounts.balance} - ${input.delta}`,
          balanceAfter: pointsAccounts.balance,
        });

      const updatedAccount = updatedRows[0];
      if (!updatedAccount) {
        const account = await this.findAccountUsing(tx, input.sessionId, input.senderId);
        if (!account) {
          throw new PointsAccountMissingError(input.sessionId, input.senderId);
        }

        throw new PointsBalanceWouldGoNegativeError(
          input.sessionId,
          input.senderId,
          account.balance,
          input.delta,
        );
      }

      const ledgerRows = await tx
        .insert(pointsLedger)
        .values({
          sessionId: input.sessionId,
          senderId: input.senderId,
          delta: input.delta,
          balanceBefore: updatedAccount.balanceBefore,
          balanceAfter: updatedAccount.balanceAfter,
          source: input.source,
          description: input.description,
          operatorId: input.operatorId,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        })
        .returning();

      const ledger = ledgerRows[0];
      if (!ledger) {
        throw new Error("积分流水写入失败");
      }

      return toLedgerRecord(ledger);
    });
  }

  private async withWriteTransaction<T>(
    operation: (tx: GatewayTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.tx) {
      return operation(this.tx);
    }

    return this.db.transaction(operation);
  }

  private executor(): PointsExecutor {
    return this.tx ?? this.db;
  }
}

export class PointsAccountMissingError extends Error {
  public constructor(
    public readonly sessionId: string,
    public readonly senderId: string,
  ) {
    super(`积分账户不存在：${sessionId}/${senderId}`);
  }
}

export class PointsBalanceWouldGoNegativeError extends Error {
  public constructor(
    public readonly sessionId: string,
    public readonly senderId: string,
    public readonly balance: number,
    public readonly delta: number,
  ) {
    super(`积分余额不能为负数，当前余额 ${balance}，变更 ${delta}`);
  }
}

export class PointsLedgerIdempotencyConflictError extends Error {
  public constructor(
    public readonly idempotencyKey: string,
    public readonly existingLedgerId: number,
  ) {
    super(`积分流水幂等键冲突：${idempotencyKey}`);
  }
}

function toAccountRecord(row: typeof pointsAccounts.$inferSelect): PointsAccountRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    senderId: row.senderId,
    balance: row.balance,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLedgerRecord(row: typeof pointsLedger.$inferSelect): PointsLedgerRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    senderId: row.senderId,
    delta: row.delta,
    balanceBefore: row.balanceBefore,
    balanceAfter: row.balanceAfter,
    source: row.source,
    description: row.description,
    operatorId: row.operatorId ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt,
  };
}

async function lockIdempotencyKey(
  tx: GatewayTransaction,
  idempotencyKey: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${idempotencyKey}), 0)`);
}

function assertLedgerMatchesInput(
  ledger: PointsLedgerRecord,
  input: ChangePointsBalanceInput,
): void {
  if (
    ledger.sessionId !== input.sessionId ||
    ledger.senderId !== input.senderId ||
    ledger.delta !== input.delta ||
    ledger.source !== input.source
  ) {
    throw new PointsLedgerIdempotencyConflictError(input.idempotencyKey!, ledger.id);
  }
}
