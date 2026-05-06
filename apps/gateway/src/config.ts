import "dotenv/config";
import { z } from "zod";
import type { BotProfile } from "./types.js";

export type MessageSourceKind = "weflow" | "wechat-http";
export type MessageSenderKind = "log" | "wechat-admin";

/**
 * 环境变量里很多值是字符串，比如 "true"、"120"、"a,b,c"。
 * 这些小工具的作用，就是在服务启动最早期把原始字符串转成业务里真正好用的类型。
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 这个 helper 主要用于 `.env` 里那种逗号分隔列表，
 * 比如 BOT_ALIASES=bot,机器人,小助手
 */
function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function emptyStringToUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
}

/**
 * envSchema 负责在“进程刚启动、业务代码还没开始跑”时先把配置校验掉。
 *
 * 这一步的意义很大：
 * 如果关键配置缺失，比如 WeFlow 地址不合法，
 * 就应该在启动时立刻失败，而不是等到 SSE 连接时才报一串难懂的错。
 */
const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  GATEWAY_HOST: z.string().default("127.0.0.1"),
  GATEWAY_PORT: z.string().default("3400"),
  ENABLE_HEALTH_SERVER: z.string().optional(),
  GATEWAY_ADMIN_TOKEN: z.string().optional(),
  REDIS_URL: z.string().default("redis://127.0.0.1:6479"),
  REDIS_KEY_PREFIX: z.string().default("wx:event-gateway"),
  SSE_DEDUPE_TTL_SECONDS: z.string().default("3600"),
  RUN_LOCK_TTL_SECONDS: z.string().default("120"),
  DATABASE_URL: z.string().url(),
  MESSAGE_SOURCE: z.enum(["weflow", "wechat-http"]).default("weflow"),
  MESSAGE_SENDER: z.enum(["log", "wechat-admin"]).default("log"),
  WEFLOW_BASE_URL: z.string().url().default("http://127.0.0.1:5031"),
  WEFLOW_ACCESS_TOKEN: z.string().optional(),
  WEFLOW_SSE_PATH: z.string().default("/api/v1/push/messages"),
  WEFLOW_MESSAGES_PATH: z.string().default("/api/v1/messages"),
  WEFLOW_FETCH_LIMIT: z.string().default("80"),
  WEFLOW_CATCHUP_FETCH_LIMIT: z.string().default("300"),
  WEFLOW_TIMEOUT_MS: z.string().default("15000"),
  WECHAT_ROBOT_WXID: z.string().optional(),
  WECHAT_CALLBACK_TOKEN: z.string().optional(),
  WECHAT_HTTP_HISTORY_LIMIT: z.string().default("300"),
  WECHAT_ADMIN_BASE_URL: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
  WECHAT_ADMIN_API_TOKEN: z.string().optional(),
  WECHAT_ADMIN_ROBOT_ID: z.string().optional(),
  WECHAT_ADMIN_SEND_TIMEOUT_MS: z.string().default("10000"),
  WECHAT_ADMIN_SEND_MIN_INTERVAL_MS: z.string().default("1000"),
  WECHAT_ADMIN_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
  GROUP_ONLY: z.string().optional(),
  QUIET_WINDOW_MS: z.string().default("8000"),
  MENTION_QUIET_WINDOW_MS: z.string().default("2000"),
  ERROR_RETRY_DELAY_MS: z.string().default("3000"),
  AGENT_CONTEXT_LIMIT: z.string().default("30"),
  AGENT_CONTEXT_CHAR_LIMIT: z.string().default("600"),
  BOT_NAME: z.string().default("bot"),
  BOT_ALIASES: z.string().optional(),
  BOT_WECHAT_IDS: z.string().optional(),
  PLUGIN_ADMIN_WECHAT_IDS: z.string().optional(),
  SCHEDULER_QUEUE_NAME: z.string().default("gateway-scheduler"),
  SCHEDULER_WORKER_CONCURRENCY: z.string().default("4"),
  SCHEDULER_DEFAULT_TIMEZONE: z.string().default("Asia/Shanghai"),
  AGENT_RUNTIME_URL: z.string().optional(),
  AGENT_RUNTIME_BEARER_TOKEN: z.string().optional(),
  AGENT_RUNTIME_TIMEOUT_MS: z.string().default("30000"),
  GRAPHITI_MCP_URL: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
  GRAPHITI_TIMEOUT_MS: z.string().default("5000"),
  GRAPHITI_GROUP_PREFIX: z.string().default("wechat:")
});

/**
 * AppConfig 是网关真正使用的运行期配置对象。
 *
 * 它和 process.env 的区别在于：
 * - 这里已经把字符串转成了 number / boolean / string[]
 * - 业务代码只依赖这个对象，不再直接操作环境变量
 *
 * 这样读代码时会清楚很多，因为每个字段的类型都稳定了。
 */
export interface AppConfig {
  nodeEnv: string;
  logLevel: string;
  gatewayHost: string;
  gatewayPort: number;
  enableHealthServer: boolean;
  gatewayAdminToken?: string;
  redisUrl: string;
  redisKeyPrefix: string;
  sseDedupeTtlSeconds: number;
  runLockTtlSeconds: number;
  databaseUrl: string;
  messageSource: MessageSourceKind;
  messageSender: MessageSenderKind;
  weflowBaseUrl: string;
  weflowAccessToken?: string;
  weflowSsePath: string;
  weflowMessagesPath: string;
  weflowFetchLimit: number;
  weflowCatchupFetchLimit: number;
  weflowTimeoutMs: number;
  wechatRobotWxid?: string;
  wechatCallbackToken?: string;
  wechatHttpHistoryLimit: number;
  wechatAdminBaseUrl?: string;
  wechatAdminApiToken?: string;
  wechatAdminRobotId?: number;
  wechatAdminSendTimeoutMs: number;
  wechatAdminSendMinIntervalMs: number;
  wechatAdminTlsRejectUnauthorized: boolean;
  groupOnly: boolean;
  quietWindowMs: number;
  mentionQuietWindowMs: number;
  errorRetryDelayMs: number;
  agentContextLimit: number;
  agentContextCharLimit: number;
  botProfile: BotProfile;
  pluginAdminWechatIds: string[];
  schedulerQueueName: string;
  schedulerWorkerConcurrency: number;
  schedulerDefaultTimezone: string;
  agentRuntimeUrl?: string;
  agentRuntimeBearerToken?: string;
  agentRuntimeTimeoutMs: number;
  graphitiMcpUrl?: string;
  graphitiTimeoutMs: number;
  graphitiGroupPrefix: string;
}

/**
 * loadConfig 是整个服务启动链路里最早执行的步骤之一。
 *
 * main() 一上来就会调用它，拿到一个“已经校验并转换完成”的配置对象，
 * 然后这个对象会被注入给 RedisStore / WeFlowClient / EventGateway 等各个模块。
 *
 * 也就是说，这个函数虽然不直接处理消息，
 * 但它决定了整个消息链路的行为参数：
 * quiet window 多长、超时时间多少、要不要启 health server、机器人叫什么等等。
 */
export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);
  const aliases = parseCsv(env.BOT_ALIASES);
  const configuredWechatIds = parseCsv(env.BOT_WECHAT_IDS);
  const pluginAdminWechatIds = parseCsv(env.PLUGIN_ADMIN_WECHAT_IDS);

  // 这里把主名字也并入 aliases，后面做 @mention 判断时就不用区分“主名”和“别名”。
  const botAliases = Array.from(new Set([env.BOT_NAME, ...aliases].filter(Boolean)));
  const wechatRobotWxid = env.WECHAT_ROBOT_WXID?.trim() || undefined;
  const wechatIds = Array.from(
    new Set(
      [...configuredWechatIds, wechatRobotWxid].filter(
        (wechatId): wechatId is string => Boolean(wechatId),
      ),
    ),
  );

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    gatewayHost: env.GATEWAY_HOST,
    gatewayPort: parseInteger(env.GATEWAY_PORT, 3400),
    enableHealthServer: parseBoolean(env.ENABLE_HEALTH_SERVER, true),
    gatewayAdminToken: env.GATEWAY_ADMIN_TOKEN?.trim() || undefined,
    redisUrl: env.REDIS_URL,
    redisKeyPrefix: env.REDIS_KEY_PREFIX,
    sseDedupeTtlSeconds: parseInteger(env.SSE_DEDUPE_TTL_SECONDS, 3600),
    runLockTtlSeconds: parseInteger(env.RUN_LOCK_TTL_SECONDS, 120),
    databaseUrl: env.DATABASE_URL,
    messageSource: env.MESSAGE_SOURCE,
    messageSender: env.MESSAGE_SENDER,
    weflowBaseUrl: env.WEFLOW_BASE_URL,
    weflowAccessToken: env.WEFLOW_ACCESS_TOKEN?.trim() || undefined,
    weflowSsePath: env.WEFLOW_SSE_PATH,
    weflowMessagesPath: env.WEFLOW_MESSAGES_PATH,
    weflowFetchLimit: parseInteger(env.WEFLOW_FETCH_LIMIT, 80),
    weflowCatchupFetchLimit: parseInteger(env.WEFLOW_CATCHUP_FETCH_LIMIT, 300),
    weflowTimeoutMs: parseInteger(env.WEFLOW_TIMEOUT_MS, 15000),
    wechatRobotWxid,
    wechatCallbackToken: env.WECHAT_CALLBACK_TOKEN?.trim() || undefined,
    wechatHttpHistoryLimit: parseInteger(env.WECHAT_HTTP_HISTORY_LIMIT, 300),
    wechatAdminBaseUrl: env.WECHAT_ADMIN_BASE_URL?.trim() || undefined,
    wechatAdminApiToken: env.WECHAT_ADMIN_API_TOKEN?.trim() || undefined,
    wechatAdminRobotId: env.WECHAT_ADMIN_ROBOT_ID?.trim()
      ? parseInteger(env.WECHAT_ADMIN_ROBOT_ID, 0)
      : undefined,
    wechatAdminSendTimeoutMs: parseInteger(env.WECHAT_ADMIN_SEND_TIMEOUT_MS, 10000),
    wechatAdminSendMinIntervalMs: Math.max(
      0,
      parseInteger(env.WECHAT_ADMIN_SEND_MIN_INTERVAL_MS, 1000),
    ),
    wechatAdminTlsRejectUnauthorized: parseBoolean(
      env.WECHAT_ADMIN_TLS_REJECT_UNAUTHORIZED,
      true,
    ),
    groupOnly: parseBoolean(env.GROUP_ONLY, true),
    quietWindowMs: parseInteger(env.QUIET_WINDOW_MS, 8000),
    mentionQuietWindowMs: parseInteger(env.MENTION_QUIET_WINDOW_MS, 2000),
    errorRetryDelayMs: parseInteger(env.ERROR_RETRY_DELAY_MS, 3000),
    agentContextLimit: parseInteger(env.AGENT_CONTEXT_LIMIT, 30),
    agentContextCharLimit: parseInteger(env.AGENT_CONTEXT_CHAR_LIMIT, 600),
    botProfile: {
      name: env.BOT_NAME,
      aliases: botAliases,
      wechatIds,
    },
    pluginAdminWechatIds,
    schedulerQueueName: env.SCHEDULER_QUEUE_NAME.trim() || "gateway-scheduler",
    schedulerWorkerConcurrency: Math.max(1, parseInteger(env.SCHEDULER_WORKER_CONCURRENCY, 4)),
    schedulerDefaultTimezone: env.SCHEDULER_DEFAULT_TIMEZONE.trim() || "Asia/Shanghai",
    agentRuntimeUrl: env.AGENT_RUNTIME_URL?.trim() || undefined,
    agentRuntimeBearerToken: env.AGENT_RUNTIME_BEARER_TOKEN?.trim() || undefined,
    agentRuntimeTimeoutMs: parseInteger(env.AGENT_RUNTIME_TIMEOUT_MS, 30000),
    graphitiMcpUrl: env.GRAPHITI_MCP_URL?.trim() || undefined,
    graphitiTimeoutMs: parseInteger(env.GRAPHITI_TIMEOUT_MS, 5000),
    graphitiGroupPrefix: env.GRAPHITI_GROUP_PREFIX,
  };
}
