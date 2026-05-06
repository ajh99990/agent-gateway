import { and, eq } from "drizzle-orm";
import { loadConfig } from "../../../config.js";
import {
  DefaultPointsService,
  PointsStore,
  PostgresPluginOperationRunStore,
  PostgresStore,
} from "../../../db/index.js";
import type { JsonValue } from "../../../db/json.js";
import {
  checkinRecords,
  pointsAccounts,
  pointsLedger,
} from "../../../db/schema/index.js";
import { createLogger } from "../../../infra/logger.js";
import type { Scheduler } from "../../../scheduler/types.js";
import { getBusinessDateKey } from "../../../time.js";
import type {
  GatewayPlugin,
  PluginCommand,
  PluginCatalog,
  PluginContext,
  PluginDataStore,
  PluginServices,
  PluginStateStore,
} from "../../types.js";
import { createCheckinPlugin } from "../checkin-plugin.js";

const CHECKIN_PLUGIN_ID = "checkin";
const CHECKIN_REWARD = 10;
const CHECKIN_TIMEZONE = "Asia/Shanghai";
const INITIAL_POINTS_BALANCE = 20;
const SMOKE_SESSION_ID = "smoke-checkin@chatroom";
const SMOKE_GROUP_NAME = "签到 Smoke 测试群";
const SMOKE_USERS = [
  {
    senderId: "smoke-checkin-user-a",
    senderName: "签到阿光",
  },
  {
    senderId: "smoke-checkin-user-b",
    senderName: "签到小林",
  },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.level = "warn";
  const postgres = new PostgresStore(config, logger);

  try {
    await postgres.ping();
    try {
      await cleanSmokeData(postgres.db);
    } catch (error) {
      if (hasPgErrorCode(error, "42P01")) {
        throw new Error("缺少 checkin_records 表，请先执行 pnpm gateway:db:migrate 后再跑 smoke。");
      }

      throw error;
    }

    const points = new DefaultPointsService(new PointsStore(postgres.db));
    const services: PluginServices = {
      sendMessage: async (input) => {
        printSection("sendMessage");
        console.log(input.text);
      },
      pluginState: createEnabledPluginState(),
      pluginData: createNoopPluginDataStore(),
      operationRuns: new PostgresPluginOperationRunStore(postgres.db),
      points,
      scheduler: createNoopScheduler(),
      plugins: createNoopPluginCatalog(),
      logger,
      adminWechatIds: [],
    };
    const plugin = createCheckinPlugin({
      config,
      db: postgres.db,
      services,
    });

    const dateKey = getBusinessDateKey(new Date(), CHECKIN_TIMEZONE);
    const todayTimestampMs = Date.parse(`${dateKey}T01:00:00.000Z`);
    const tomorrowTimestampMs = todayTimestampMs + 24 * 60 * 60 * 1000;
    const tomorrowDateKey = getBusinessDateKey(tomorrowTimestampMs, CHECKIN_TIMEZONE);

    await runCheckin(plugin, services, {
      content: "签到",
      userIndex: 0,
      timestampMs: todayTimestampMs,
    });
    await assertBalance(points, SMOKE_USERS[0]!.senderId, 30, "首次签到后余额");
    await assertDailyRecordCount(postgres.db, dateKey, SMOKE_USERS[0]!.senderId, 1);

    await runCheckin(plugin, services, {
      content: "上班",
      userIndex: 0,
      timestampMs: todayTimestampMs,
    });
    await assertBalance(points, SMOKE_USERS[0]!.senderId, 30, "重复签到后余额");
    await assertDailyRecordCount(postgres.db, dateKey, SMOKE_USERS[0]!.senderId, 1);

    await runCheckin(plugin, services, {
      content: "上班",
      userIndex: 1,
      timestampMs: todayTimestampMs,
    });
    await assertBalance(points, SMOKE_USERS[1]!.senderId, 30, "同日另一用户签到后余额");
    await assertDailyRecordCount(postgres.db, dateKey, SMOKE_USERS[1]!.senderId, 1);

    await runCheckin(plugin, services, {
      content: "签到",
      userIndex: 0,
      timestampMs: tomorrowTimestampMs,
    });
    await assertBalance(points, SMOKE_USERS[0]!.senderId, 40, "次日签到后余额");
    await assertDailyRecordCount(postgres.db, tomorrowDateKey, SMOKE_USERS[0]!.senderId, 1);

    await printDbCounts(postgres.db);
    printSection("result");
    console.log("checkin smoke passed");
  } finally {
    await postgres.disconnect();
  }
}

async function cleanSmokeData(db: PostgresStore["db"]): Promise<void> {
  await db.delete(checkinRecords).where(eq(checkinRecords.sessionId, SMOKE_SESSION_ID));
  await db.delete(pointsLedger).where(eq(pointsLedger.sessionId, SMOKE_SESSION_ID));
  await db.delete(pointsAccounts).where(eq(pointsAccounts.sessionId, SMOKE_SESSION_ID));
}

async function runCheckin(
  plugin: GatewayPlugin,
  services: PluginServices,
  input: {
    content: string;
    userIndex: number;
    timestampMs: number;
  },
): Promise<void> {
  const user = SMOKE_USERS[input.userIndex]!;
  const context = createContext(input.content, user, services, input.timestampMs);
  const command = findCommand(plugin, input.content);
  if (!command) {
    throw new Error(`签到插件未匹配指令：${input.content}`);
  }

  const result = await command.handle(context);

  printSection(`${context.message.senderName}: ${input.content}`);
  console.log(result.replyText ?? "(no reply)");

  const expectedText = input.content === "签到" || input.content === "上班";
  if (expectedText && !result.replyText?.trim()) {
    throw new Error("签到插件没有返回回复文本");
  }
}

function findCommand(plugin: GatewayPlugin, content: string): PluginCommand | undefined {
  return plugin.commands?.find(
    (command) =>
      command.matches?.(content) ||
      command.keywords?.some((keyword) => keyword.trim() === content),
  );
}

function createContext(
  content: string,
  user: typeof SMOKE_USERS[number],
  services: PluginServices,
  timestampMs: number,
): PluginContext {
  const fingerprint = `${SMOKE_SESSION_ID}:${timestampMs}:${user.senderId}:${content}`;

  return {
    sessionId: SMOKE_SESSION_ID,
    groupName: SMOKE_GROUP_NAME,
    content,
    event: {
      source: "smoke",
      event: "message.new",
      sessionId: SMOKE_SESSION_ID,
      messageKey: `server:smoke:0:0:${timestampMs}:${user.senderId}:0`,
      groupName: SMOKE_GROUP_NAME,
      content,
      receivedAtUnixMs: timestampMs,
    },
    message: {
      sessionId: SMOKE_SESSION_ID,
      groupName: SMOKE_GROUP_NAME,
      localId: timestampMs,
      senderId: user.senderId,
      senderName: user.senderName,
      timestamp: new Date(timestampMs).toISOString(),
      createdAtUnixMs: timestampMs,
      content,
      rawContent: content,
      contentType: "text",
      isGroup: true,
      isSelfSent: false,
      isFromBot: false,
      isMentionBot: false,
      fingerprint,
    },
    services,
  };
}

async function assertBalance(
  points: DefaultPointsService,
  senderId: string,
  expectedBalance: number,
  label: string,
): Promise<void> {
  const balance = await points.getBalance(SMOKE_SESSION_ID, senderId);
  if (balance.balance !== expectedBalance) {
    throw new Error(`${label}不符合预期：expected=${expectedBalance}, actual=${balance.balance}`);
  }
}

async function assertDailyRecordCount(
  db: PostgresStore["db"],
  dateKey: string,
  senderId: string,
  expectedCount: number,
): Promise<void> {
  const rows = await db
    .select()
    .from(checkinRecords)
    .where(
      and(
        eq(checkinRecords.sessionId, SMOKE_SESSION_ID),
        eq(checkinRecords.senderId, senderId),
        eq(checkinRecords.dateKey, dateKey),
      ),
    );

  if (rows.length !== expectedCount) {
    throw new Error(
      `签到记录数量不符合预期：dateKey=${dateKey}, senderId=${senderId}, expected=${expectedCount}, actual=${rows.length}`,
    );
  }
}

async function printDbCounts(db: PostgresStore["db"]): Promise<void> {
  printSection("db counts");
  const records = await db
    .select()
    .from(checkinRecords)
    .where(eq(checkinRecords.sessionId, SMOKE_SESSION_ID));
  const ledgers = await db
    .select()
    .from(pointsLedger)
    .where(eq(pointsLedger.sessionId, SMOKE_SESSION_ID));
  const accounts = await db
    .select()
    .from(pointsAccounts)
    .where(eq(pointsAccounts.sessionId, SMOKE_SESSION_ID));

  console.log({
    checkinRecords: records.length,
    pointsAccounts: accounts.length,
    pointsLedger: ledgers.length,
    expectedUserABalance: INITIAL_POINTS_BALANCE + CHECKIN_REWARD * 2,
    expectedUserBBalance: INITIAL_POINTS_BALANCE + CHECKIN_REWARD,
  });
}

function createEnabledPluginState(): PluginStateStore {
  return {
    async isEnabled() {
      return true;
    },
    async setEnabled() {},
    async listEnabledSessions() {
      return [
        {
          sessionId: SMOKE_SESSION_ID,
          groupName: SMOKE_GROUP_NAME,
          lastSeenAt: new Date(),
        },
      ];
    },
  };
}

function createNoopPluginDataStore(): PluginDataStore {
  const data = new Map<string, JsonValue>();
  return {
    async getValue<T extends JsonValue = JsonValue>(pluginId: string, sessionId: string, key: string) {
      return (data.get(`${pluginId}:${sessionId}:${key}`) as T | undefined) ?? null;
    },
    async setValue(pluginId: string, sessionId: string, key: string, value: JsonValue) {
      data.set(`${pluginId}:${sessionId}:${key}`, value);
    },
    async deleteValue(pluginId: string, sessionId: string, key: string) {
      data.delete(`${pluginId}:${sessionId}:${key}`);
    },
    async listKeys() {
      return [];
    },
  };
}

function createNoopScheduler(): Scheduler {
  return {
    registerJob() {},
    async enqueueJob() {},
    async start() {},
    async stop() {},
    async getSnapshot() {
      return {
        status: "stopped",
        queueName: "smoke",
        workerRunning: false,
        workerConcurrency: 1,
        registeredJobs: 0,
        scheduledJobs: 0,
      };
    },
  };
}

function createNoopPluginCatalog(): PluginCatalog {
  return {
    listPlugins() {
      return [];
    },
    findPluginByName() {
      return undefined;
    },
    getPluginById(): GatewayPlugin | undefined {
      return undefined;
    },
  };
}

function printSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function hasPgErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const candidate = current as { cause?: unknown; code?: unknown };
    if (candidate.code === code) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
