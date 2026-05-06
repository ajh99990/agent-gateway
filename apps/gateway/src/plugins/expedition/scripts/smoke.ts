import { eq } from "drizzle-orm";
import { loadConfig } from "../../../config.js";
import {
  DefaultPointsService,
  PointsStore,
  PostgresPluginOperationRunStore,
  PostgresStore,
} from "../../../db/index.js";
import {
  expeditionEntries,
  expeditionPlayers,
  expeditionRelics,
  expeditionReports,
  expeditionWorlds,
  pluginOperationRuns,
  pointsAccounts,
  pointsLedger,
} from "../../../db/schema/index.js";
import type { JsonValue } from "../../../db/json.js";
import { createLogger } from "../../../infra/logger.js";
import { createGatewayPlugins } from "../../index.js";
import type {
  GatewayPlugin,
  PluginCommand,
  PluginCatalog,
  PluginContext,
  PluginDataStore,
  PluginServices,
  PluginStateStore,
} from "../../types.js";
import {
  EXPEDITION_PLUGIN_ID,
  EXPEDITION_TIMEZONE,
} from "../expedition-types.js";
import { getBusinessDateKey } from "../../../time.js";
import type { Scheduler } from "../../../scheduler/types.js";

const SMOKE_SESSION_ID = "smoke-expedition@chatroom";
const SMOKE_GROUP_NAME = "远征 Smoke 测试群";
const SMOKE_USERS = [
  {
    senderId: "smoke-user-a",
    senderName: "烟测阿光",
    initialPoints: 500,
  },
  {
    senderId: "smoke-user-b",
    senderName: "烟测小林",
    initialPoints: 500,
  },
  {
    senderId: "smoke-user-c",
    senderName: "烟测老王",
    initialPoints: 500,
  },
  {
    senderId: "smoke-user-d",
    senderName: "烟测小周",
    initialPoints: 0,
  },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const postgres = new PostgresStore(config, logger);
  const sentMessages: string[] = [];

  try {
    await postgres.ping();
    const dateKey = getBusinessDateKey(new Date(), EXPEDITION_TIMEZONE);
    const messageTimestampMs = Date.parse(`${dateKey}T01:00:00.000Z`);

    await cleanSmokeData(postgres.db);

    const points = new DefaultPointsService(new PointsStore(postgres.db));
    const operationRuns = new PostgresPluginOperationRunStore(postgres.db);
    const services: PluginServices = {
      sendMessage: async (input) => {
        sentMessages.push(input.text);
        printSection("sendMessage");
        console.log(input.text);
      },
      pluginState: createEnabledPluginState(),
      pluginData: createNoopPluginDataStore(),
      operationRuns,
      points,
      scheduler: createNoopScheduler(),
      plugins: createNoopPluginCatalog(),
      logger,
      adminWechatIds: [],
    };
    const plugins = createGatewayPlugins({
      config,
      db: postgres.db,
      services,
    });
    const expedition = plugins.find((plugin) => plugin.id === EXPEDITION_PLUGIN_ID);
    if (!expedition) {
      throw new Error("createGatewayPlugins 未注册远征插件");
    }
    if (!findCommand(expedition, "远征 疯狂 梭哈")) {
      throw new Error("远征插件未匹配带参数远征指令");
    }
    if (!findCommand(expedition, "加码")) {
      throw new Error("远征插件未匹配加码指令");
    }
    if (expedition.scheduledJobs?.length !== 2) {
      throw new Error("远征插件应注册 2 个每日定时任务");
    }

    await seedPoints(points, dateKey);
    const boostTimestampMs = Date.parse(`${dateKey}T09:45:00.000Z`);

    await runCommand(expedition, services, {
      content: "远征 冒险 50",
      userIndex: 0,
      messageTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "远征 稳健 80",
      userIndex: 0,
      messageTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "远征 疯狂 梭哈",
      userIndex: 1,
      messageTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "加码",
      userIndex: 1,
      messageTimestampMs: boostTimestampMs,
    });
    await assertEntryState(postgres.db, dateKey, SMOKE_USERS[1]!.senderId, {
      stake: 520,
      boosted: true,
      boostStake: 104,
    });
    await runCommand(expedition, services, {
      content: "加码",
      userIndex: 1,
      messageTimestampMs: boostTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "远征 稳健 80",
      userIndex: 1,
      messageTimestampMs: boostTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "取消远征",
      userIndex: 1,
      messageTimestampMs: boostTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "远征 稳健 20",
      userIndex: 2,
      messageTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "取消远征",
      userIndex: 2,
      messageTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "加码",
      userIndex: 2,
      messageTimestampMs: boostTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "远征 冒险 12",
      userIndex: 3,
      messageTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "加码",
      userIndex: 3,
      messageTimestampMs: boostTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "我的战报",
      userIndex: 0,
      messageTimestampMs,
    });

    printSection("runBoostReminder");
    await runScheduledJob(expedition, "expedition.boost-reminder", `${dateKey}T09:40:00.000Z`);
    console.log(`boost reminder sent, messages=${sentMessages.length}`);

    printSection("runDailySettlement");
    await runScheduledJob(expedition, "expedition.daily-settlement", `${dateKey}T09:50:00.000Z`);
    console.log(`settled dateKey=${dateKey}, announcements=${sentMessages.length}`);

    printSection("runDailySettlement again");
    await runScheduledJob(expedition, "expedition.daily-settlement", `${dateKey}T09:50:00.000Z`);
    console.log("second settlement call completed");

    await runCommand(expedition, services, {
      content: "我的战报",
      userIndex: 0,
      messageTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "我的战报",
      userIndex: 1,
      messageTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "我的遗物",
      userIndex: 0,
      messageTimestampMs,
    });
    await runCommand(expedition, services, {
      content: "远征排行",
      userIndex: 0,
      messageTimestampMs,
    });

    await printBalances(points);
    await printDbCounts(postgres.db);
  } finally {
    await postgres.disconnect();
  }
}

async function cleanSmokeData(db: PostgresStore["db"]): Promise<void> {
  await db.delete(expeditionReports).where(eq(expeditionReports.sessionId, SMOKE_SESSION_ID));
  await db.delete(expeditionRelics).where(eq(expeditionRelics.sessionId, SMOKE_SESSION_ID));
  await db.delete(expeditionEntries).where(eq(expeditionEntries.sessionId, SMOKE_SESSION_ID));
  await db.delete(expeditionPlayers).where(eq(expeditionPlayers.sessionId, SMOKE_SESSION_ID));
  await db.delete(expeditionWorlds).where(eq(expeditionWorlds.sessionId, SMOKE_SESSION_ID));
  await db.delete(pointsLedger).where(eq(pointsLedger.sessionId, SMOKE_SESSION_ID));
  await db.delete(pointsAccounts).where(eq(pointsAccounts.sessionId, SMOKE_SESSION_ID));
  await db.delete(pluginOperationRuns).where(eq(pluginOperationRuns.scopeId, SMOKE_SESSION_ID));
}

async function seedPoints(points: DefaultPointsService, dateKey: string): Promise<void> {
  for (const user of SMOKE_USERS) {
    if (user.initialPoints <= 0) {
      continue;
    }

    await points.earn({
      sessionId: SMOKE_SESSION_ID,
      senderId: user.senderId,
      amount: user.initialPoints,
      source: EXPEDITION_PLUGIN_ID,
      description: "远征 smoke 测试积分",
      operatorId: "smoke",
      idempotencyKey: `${EXPEDITION_PLUGIN_ID}:smoke:${dateKey}:${user.senderId}:seed`,
      metadata: {
        smoke: true,
      },
    });
  }
}

async function runCommand(
  expedition: GatewayPlugin,
  services: PluginServices,
  input: {
    content: string;
    userIndex: number;
    messageTimestampMs: number;
  },
): Promise<void> {
  const context = createContext(input.content, SMOKE_USERS[input.userIndex]!, services, input.messageTimestampMs);
  const command = findCommand(expedition, input.content);
  if (!command) {
    throw new Error(`远征插件未匹配指令：${input.content}`);
  }

  const result = await command.handle(context);
  printSection(`${context.message.senderName}: ${input.content}`);
  console.log(result.replyText ?? "(no reply)");
}

async function runScheduledJob(
  expedition: GatewayPlugin,
  jobId: string,
  timestamp: string,
): Promise<void> {
  const job = expedition.scheduledJobs?.find((candidate) => candidate.id === jobId);
  if (!job) {
    throw new Error(`远征插件缺少定时任务：${jobId}`);
  }

  await job.process({
    data: {},
    execution: {
      id: job.id,
      name: job.name ?? job.id,
      attemptsMade: 0,
      timestamp,
    },
    scheduler: createNoopScheduler(),
  });
}

async function assertEntryState(
  db: PostgresStore["db"],
  dateKey: string,
  senderId: string,
  expected: {
    stake: number;
    boosted: boolean;
    boostStake: number;
  },
): Promise<void> {
  const rows = await db
    .select()
    .from(expeditionEntries)
    .where(eq(expeditionEntries.sessionId, SMOKE_SESSION_ID));
  const entry = rows.find((row) => row.dateKey === dateKey && row.senderId === senderId);
  if (!entry) {
    throw new Error(`未找到远征报名记录：${senderId}`);
  }
  if (
    entry.stake !== expected.stake ||
    entry.boosted !== expected.boosted ||
    entry.boostStake !== expected.boostStake
  ) {
    throw new Error(
      `远征加码状态不符合预期：expected=${JSON.stringify(expected)}, actual=${JSON.stringify({
        stake: entry.stake,
        boosted: entry.boosted,
        boostStake: entry.boostStake,
      })}`,
    );
  }
}

function createContext(
  content: string,
  user: typeof SMOKE_USERS[number],
  services: PluginServices,
  timestampMs: number,
): PluginContext {
  const fingerprint = `${SMOKE_SESSION_ID}:${Date.now()}:${user.senderId}:${content}`;

  return {
    sessionId: SMOKE_SESSION_ID,
    groupName: SMOKE_GROUP_NAME,
    content,
    event: {
      source: "smoke",
      event: "message.new",
      sessionId: SMOKE_SESSION_ID,
      messageKey: `server:smoke:0:0:${Date.now()}:${user.senderId}:0`,
      groupName: SMOKE_GROUP_NAME,
      content,
      receivedAtUnixMs: timestampMs,
    },
    message: {
      sessionId: SMOKE_SESSION_ID,
      groupName: SMOKE_GROUP_NAME,
      localId: Date.now(),
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

function findCommand(plugin: GatewayPlugin, content: string): PluginCommand | undefined {
  return plugin.commands?.find(
    (command) =>
      command.matches?.(content) ||
      command.keywords?.some((keyword) => keyword.trim() === content),
  );
}

async function printBalances(points: DefaultPointsService): Promise<void> {
  printSection("balances");
  for (const user of SMOKE_USERS) {
    const balance = await points.getBalance(SMOKE_SESSION_ID, user.senderId);
    console.log(`${user.senderName}: ${balance.balance}`);
  }
}

async function printDbCounts(db: PostgresStore["db"]): Promise<void> {
  printSection("db counts");
  const entries = await db.select().from(expeditionEntries).where(eq(expeditionEntries.sessionId, SMOKE_SESSION_ID));
  const reports = await db.select().from(expeditionReports).where(eq(expeditionReports.sessionId, SMOKE_SESSION_ID));
  const relics = await db.select().from(expeditionRelics).where(eq(expeditionRelics.sessionId, SMOKE_SESSION_ID));
  const worlds = await db.select().from(expeditionWorlds).where(eq(expeditionWorlds.sessionId, SMOKE_SESSION_ID));
  console.log({
    entries: entries.length,
    reports: reports.length,
    relics: relics.length,
    worlds: worlds.length,
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

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
