import type { GatewayTransaction } from "../client.js";
import type { JsonValue } from "../json.js";
import {
  PointsAccountMissingError,
  PointsBalanceWouldGoNegativeError,
  PointsStore,
  type ChangePointsBalanceInput,
  type PointsAccountRecord,
  type PointsLedgerRecord,
} from "../stores/index.js";

const INITIAL_POINTS_BALANCE = 20;
const INITIAL_POINTS_SOURCE = "initial_grant";
const INITIAL_POINTS_DESCRIPTION = "初始积分";
const SYSTEM_OPERATOR_ID = "system";

export interface PointsAccountSnapshot {
  sessionId: string;
  senderId: string;
  balance: number;
}

export interface PointsLedgerEntry {
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

export interface ChangePointsInput {
  sessionId: string;
  senderId: string;
  amount: number;
  source: string;
  description: string;
  operatorId?: string;
  idempotencyKey?: string;
  metadata?: JsonValue;
}

export interface AdjustPointsInput {
  sessionId: string;
  senderId: string;
  delta: number;
  source: string;
  description: string;
  operatorId?: string;
  idempotencyKey?: string;
  metadata?: JsonValue;
}

export interface PointsService {
  withTransaction(tx: GatewayTransaction): PointsService;
  getBalance(sessionId: string, senderId: string): Promise<PointsAccountSnapshot>;
  earn(input: ChangePointsInput): Promise<PointsLedgerEntry>;
  spend(input: ChangePointsInput): Promise<PointsLedgerEntry>;
  adjust(input: AdjustPointsInput): Promise<PointsLedgerEntry>;
}

export class InvalidPointsAmountError extends Error {
  public constructor(
    message: string,
    public readonly amount: number,
  ) {
    super(message);
  }
}

export class InsufficientPointsError extends Error {
  public constructor(
    public readonly sessionId: string,
    public readonly senderId: string,
    public readonly balance: number,
    public readonly requestedAmount: number,
  ) {
    super(`积分不足，当前余额 ${balance}，需要 ${requestedAmount}`);
  }
}

export class DefaultPointsService implements PointsService {
  public constructor(private readonly store: PointsStore) {}

  public withTransaction(tx: GatewayTransaction): PointsService {
    return new DefaultPointsService(this.store.withTransaction(tx));
  }

  public async getBalance(sessionId: string, senderId: string): Promise<PointsAccountSnapshot> {
    const account = await this.ensureAccount(
      normalizeRequiredText(sessionId, "sessionId"),
      normalizeRequiredText(senderId, "senderId"),
    );

    return toAccountSnapshot(account);
  }

  public async earn(input: ChangePointsInput): Promise<PointsLedgerEntry> {
    const normalized = normalizeChangeInput(input);
    await this.ensureAccount(normalized.sessionId, normalized.senderId);

    const ledger = await this.changeBalance(
      {
        ...normalized,
        delta: normalized.amount,
      },
      normalized.amount,
    );

    return toLedgerEntry(ledger);
  }

  public async spend(input: ChangePointsInput): Promise<PointsLedgerEntry> {
    const normalized = normalizeChangeInput(input);
    await this.ensureAccount(normalized.sessionId, normalized.senderId);

    const ledger = await this.changeBalance(
      {
        ...normalized,
        delta: -normalized.amount,
      },
      normalized.amount,
    );

    return toLedgerEntry(ledger);
  }

  public async adjust(input: AdjustPointsInput): Promise<PointsLedgerEntry> {
    const normalized = normalizeAdjustInput(input);
    await this.ensureAccount(normalized.sessionId, normalized.senderId);

    const ledger = await this.changeBalance(normalized, Math.abs(normalized.delta));
    return toLedgerEntry(ledger);
  }

  private async changeBalance(
    input: ChangePointsBalanceInput,
    requestedAmount: number,
  ): Promise<PointsLedgerRecord> {
    try {
      return await this.store.changeBalance(input);
    } catch (error) {
      if (error instanceof PointsBalanceWouldGoNegativeError) {
        throw new InsufficientPointsError(
          error.sessionId,
          error.senderId,
          error.balance,
          requestedAmount,
        );
      }

      if (error instanceof PointsAccountMissingError) {
        throw new Error("积分账户不存在，请先创建账户");
      }

      throw error;
    }
  }

  private async ensureAccount(sessionId: string, senderId: string): Promise<PointsAccountRecord> {
    const existing = await this.store.findAccount(sessionId, senderId);
    if (existing) {
      return existing;
    }

    return this.store.createInitialAccount({
      sessionId,
      senderId,
      initialBalance: INITIAL_POINTS_BALANCE,
      source: INITIAL_POINTS_SOURCE,
      description: INITIAL_POINTS_DESCRIPTION,
      operatorId: SYSTEM_OPERATOR_ID,
      metadata: {
        reason: "lazy_create_account",
      },
    });
  }
}

interface NormalizedChangePointsInput extends ChangePointsInput {
  amount: number;
}

interface NormalizedAdjustPointsInput extends AdjustPointsInput {
  delta: number;
}

function normalizeChangeInput(input: ChangePointsInput): NormalizedChangePointsInput {
  const amount = normalizePositiveInteger(input.amount, "amount");

  return {
    sessionId: normalizeRequiredText(input.sessionId, "sessionId"),
    senderId: normalizeRequiredText(input.senderId, "senderId"),
    amount,
    source: normalizeRequiredText(input.source, "source"),
    description: normalizeRequiredText(input.description, "description"),
    operatorId: normalizeOptionalText(input.operatorId),
    idempotencyKey: normalizeOptionalText(input.idempotencyKey),
    metadata: input.metadata,
  };
}

function normalizeAdjustInput(input: AdjustPointsInput): NormalizedAdjustPointsInput {
  const delta = normalizeNonZeroInteger(input.delta, "delta");

  return {
    sessionId: normalizeRequiredText(input.sessionId, "sessionId"),
    senderId: normalizeRequiredText(input.senderId, "senderId"),
    delta,
    source: normalizeRequiredText(input.source, "source"),
    description: normalizeRequiredText(input.description, "description"),
    operatorId: normalizeOptionalText(input.operatorId),
    idempotencyKey: normalizeOptionalText(input.idempotencyKey),
    metadata: input.metadata,
  };
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidPointsAmountError(`${fieldName} 必须是正整数`, value);
  }

  return value;
}

function normalizeNonZeroInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value === 0) {
    throw new InvalidPointsAmountError(`${fieldName} 必须是非零整数`, value);
  }

  return value;
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} 不能为空`);
  }

  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function toAccountSnapshot(record: PointsAccountRecord): PointsAccountSnapshot {
  return {
    sessionId: record.sessionId,
    senderId: record.senderId,
    balance: record.balance,
  };
}

function toLedgerEntry(record: PointsLedgerRecord): PointsLedgerEntry {
  return {
    id: record.id,
    sessionId: record.sessionId,
    senderId: record.senderId,
    delta: record.delta,
    balanceBefore: record.balanceBefore,
    balanceAfter: record.balanceAfter,
    source: record.source,
    description: record.description,
    operatorId: record.operatorId,
    idempotencyKey: record.idempotencyKey,
    metadata: record.metadata,
    createdAt: record.createdAt,
  };
}
