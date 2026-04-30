import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { hashPassword } from "../apps/web/lib/password";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY_ENV_PATH = path.join(ROOT, "apps/gateway/.env");
const WEB_ENV_PATH = path.join(ROOT, "apps/web/.env");

interface Answers {
  webPassword: string;
  weflowBaseUrl: string;
  weflowAccessToken: string;
  botName: string;
  botAliases: string;
  botWechatIds: string;
  pluginAdminWechatIds: string;
  agentRuntimeUrl: string;
  graphitiMcpUrl: string;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  try {
    const existingFiles = [GATEWAY_ENV_PATH, WEB_ENV_PATH].filter((filePath) => existsSync(filePath));
    const overwrite =
      existingFiles.length === 0
        ? true
        : await confirm(
            rl,
            `检测到已有 ${existingFiles.map((filePath) => path.relative(ROOT, filePath)).join(", ")}，是否覆盖？`,
            false,
          );

    if (!overwrite) {
      console.log("已取消初始化，没有修改 .env 文件。");
      return;
    }

    const answers = await collectAnswers(rl);
    const gatewayAdminToken = randomSecret();
    const webSessionSecret = randomSecret();
    const webPasswordHash = await hashPassword(answers.webPassword);
    const gatewayPort = "3400";

    await writeEnvFile(GATEWAY_ENV_PATH, buildGatewayEnv({
      ...answers,
      gatewayAdminToken,
      gatewayPort,
    }));
    await writeEnvFile(WEB_ENV_PATH, buildWebEnv({
      gatewayAdminToken,
      gatewayPort,
      webPasswordHash,
      webSessionSecret,
    }));

    console.log("");
    console.log("初始化完成：");
    console.log(`- ${path.relative(ROOT, GATEWAY_ENV_PATH)}`);
    console.log(`- ${path.relative(ROOT, WEB_ENV_PATH)}`);
    console.log("");
    console.log("下一步：");
    console.log("1. pnpm gateway:dev");
    console.log("2. pnpm web:dev");
    console.log("3. 打开 http://127.0.0.1:3000 并使用刚才输入的密码登录");
  } finally {
    rl.close();
  }
}

async function collectAnswers(rl: readline.Interface): Promise<Answers> {
  const webPassword = await askPasswordTwice(rl);
  const weflowBaseUrl = await ask(rl, "WeFlow Base URL", "http://127.0.0.1:5031");
  const weflowAccessToken = await ask(rl, "WeFlow Access Token（可留空）", "");
  const botName = await ask(rl, "机器人名称", "bot");
  const botAliases = await ask(rl, "机器人别名，逗号分隔", botName);
  const botWechatIds = await ask(rl, "机器人微信 ID，逗号分隔（可留空）", "");
  const pluginAdminWechatIds = await ask(rl, "插件管理员微信 ID，逗号分隔（可留空）", "");
  const agentRuntimeUrl = await ask(rl, "Agent Runtime URL（可留空）", "");
  const graphitiMcpUrl = await ask(rl, "Graphiti MCP URL（可留空）", "");

  return {
    webPassword,
    weflowBaseUrl,
    weflowAccessToken,
    botName,
    botAliases,
    botWechatIds,
    pluginAdminWechatIds,
    agentRuntimeUrl,
    graphitiMcpUrl,
  };
}

async function ask(
  rl: readline.Interface,
  label: string,
  defaultValue: string,
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : " [留空]";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || defaultValue;
}

async function confirm(
  rl: readline.Interface,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? "Y/n" : "y/N";
  const answer = (await rl.question(`${label} (${suffix}): `)).trim().toLowerCase();
  if (!answer) {
    return defaultValue;
  }

  return ["y", "yes"].includes(answer);
}

async function askPasswordTwice(rl: readline.Interface): Promise<string> {
  while (true) {
    const password = await rl.question("Web 控制台登录密码: ");
    if (password.length < 8) {
      console.log("密码至少需要 8 个字符。");
      continue;
    }

    const repeated = await rl.question("再次输入登录密码: ");
    if (password !== repeated) {
      console.log("两次密码不一致，请重新输入。");
      continue;
    }

    return password;
  }
}

async function writeEnvFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${content.trim()}\n`, "utf8");
}

function randomSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

function buildGatewayEnv(input: Answers & {
  gatewayAdminToken: string;
  gatewayPort: string;
}): string {
  return `
NODE_ENV=development
LOG_LEVEL=info

GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=${input.gatewayPort}
ENABLE_HEALTH_SERVER=true
GATEWAY_ADMIN_TOKEN=${input.gatewayAdminToken}

REDIS_URL=redis://127.0.0.1:6479
REDIS_KEY_PREFIX=wx:event-gateway
SSE_DEDUPE_TTL_SECONDS=3600
RUN_LOCK_TTL_SECONDS=120

WEFLOW_BASE_URL=${input.weflowBaseUrl}
WEFLOW_ACCESS_TOKEN=${input.weflowAccessToken}
WEFLOW_SSE_PATH=/api/v1/push/messages
WEFLOW_MESSAGES_PATH=/api/v1/messages
WEFLOW_FETCH_LIMIT=80
WEFLOW_CATCHUP_FETCH_LIMIT=300
WEFLOW_TIMEOUT_MS=15000

GROUP_ONLY=true
QUIET_WINDOW_MS=8000
MENTION_QUIET_WINDOW_MS=2000
ERROR_RETRY_DELAY_MS=3000
AGENT_CONTEXT_LIMIT=30
AGENT_CONTEXT_CHAR_LIMIT=600

BOT_NAME=${input.botName}
BOT_ALIASES=${input.botAliases}
BOT_WECHAT_IDS=${input.botWechatIds}
PLUGIN_ADMIN_WECHAT_IDS=${input.pluginAdminWechatIds}

AGENT_RUNTIME_URL=${input.agentRuntimeUrl}
AGENT_RUNTIME_BEARER_TOKEN=
AGENT_RUNTIME_TIMEOUT_MS=30000

GRAPHITI_MCP_URL=${input.graphitiMcpUrl}
GRAPHITI_TIMEOUT_MS=5000
GRAPHITI_GROUP_PREFIX=wechat:
`;
}

function buildWebEnv(input: {
  gatewayAdminToken: string;
  gatewayPort: string;
  webPasswordHash: string;
  webSessionSecret: string;
}): string {
  return `
WEB_ADMIN_PASSWORD_HASH=${input.webPasswordHash}
WEB_SESSION_SECRET=${input.webSessionSecret}
GATEWAY_ADMIN_BASE_URL=http://127.0.0.1:${input.gatewayPort}
GATEWAY_ADMIN_TOKEN=${input.gatewayAdminToken}
`;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
