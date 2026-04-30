import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { GraphitiClient, type GraphitiMemoryInput } from "../graphiti-client.js";
import { createLogger } from "../logger.js";

/**
 * 这是“人格 seed memory 导入脚本”。
 *
 * 它和 import-history.ts 的区别是：
 * - import-history.ts 导的是某个群的历史聊天记录
 * - 这个脚本导的是角色稳定背景、性格、动机、敏感点这类长期人格记忆
 *
 * 这些内容不属于具体某个微信群，所以这里不会使用 sessionId，
 * 而是统一写进一个固定的人格 group：persona_chen_jianing_core
 */

/**
 * 这里直接写死 seed 文件路径，后面如果你换成别的人设文件，
 * 直接改这个常量就可以。
 */
const INPUT_FILE_PATH = "F:\\project\\graphiti\\graphiti_role_memory\\chen_jianing_seed_memories.json";

/**
 * 当前先不再拆更多层，全部种子记忆统一写入这一层。
 */
const TARGET_GROUP_ID = "persona_chen_jianing_core";

/**
 * 如果你准备“重置人设后重新播种”，可以把这里改成 true。
 * 这样脚本会先清空 persona_chen_jianing_core，再重新导入。
 *
 * 默认保持 false，避免你不小心把已有数据清掉。
 */
const CLEAR_TARGET_GROUP_BEFORE_IMPORT = true;

/**
 * add_memory 在 Graphiti 里通常是先入队、后异步处理。
 * 这里默认等待，直到这些 seed memories 至少已经能通过 get_episodes 查到。
 */
const WAIT_FOR_BACKGROUND_PROCESSING = true;
const WAIT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

interface PersonaSeedPackage {
  source_description?: string;
  seed_memories: PersonaSeedMemory[];
}

interface PersonaSeedMemory {
  id?: string;
  name?: string;
  source?: string;
  tags?: unknown;
  importance?: string;
  episode_body?: unknown;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (!config.graphitiMcpUrl) {
    throw new Error("当前没有配置 GRAPHITI_MCP_URL，无法导入人格 seed memory 到 Graphiti");
  }

  logger.info(
    {
      inputFilePath: INPUT_FILE_PATH,
      targetGroupId: TARGET_GROUP_ID,
    },
    "开始读取人格 seed memory 文件",
  );

  const seedPackage = await loadSeedPackage(INPUT_FILE_PATH);
  const payloads = buildMemoryPayloads(seedPackage);

  logger.info(
    {
      targetGroupId: TARGET_GROUP_ID,
      memoryCount: payloads.length,
      clearFirst: CLEAR_TARGET_GROUP_BEFORE_IMPORT,
      waitForBackgroundProcessing: WAIT_FOR_BACKGROUND_PROCESSING,
    },
    "人格 seed memory 文件读取完成，开始准备导入 Graphiti",
  );

  const graphitiClient = new GraphitiClient(config, logger);
  await graphitiClient.start();

  try {
    if (CLEAR_TARGET_GROUP_BEFORE_IMPORT) {
      logger.warn(
        { targetGroupId: TARGET_GROUP_ID },
        "准备先清空目标 persona group，再重新导入 seed memory",
      );
      await graphitiClient.clearGroup(TARGET_GROUP_ID);
    }

    for (const [index, payload] of payloads.entries()) {
      logger.info(
        {
          targetGroupId: payload.groupId,
          index: index + 1,
          total: payloads.length,
          name: payload.name,
        },
        "开始导入一条人格 seed memory 到 Graphiti",
      );

      await graphitiClient.addMemory(payload);
    }

    if (!WAIT_FOR_BACKGROUND_PROCESSING) {
      logger.info(
        {
          targetGroupId: TARGET_GROUP_ID,
          memoryCount: payloads.length,
        },
        "所有人格 seed memory 已提交给 Graphiti；后端仍会异步处理",
      );
      return;
    }

    logger.info(
      {
        targetGroupId: TARGET_GROUP_ID,
        waitTimeoutMs: WAIT_TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
      },
      "已提交全部人格 seed memory，开始等待 Graphiti 后台处理完成",
    );

    const ready = await waitUntilEpisodesAreQueryable(
      graphitiClient,
      TARGET_GROUP_ID,
      payloads.map((payload) => payload.name),
      logger,
    );

    if (!ready) {
      logger.warn(
        {
          targetGroupId: TARGET_GROUP_ID,
          memoryCount: payloads.length,
        },
        "等待超时；seed memory 可能仍在 Graphiti 后台处理中",
      );
      return;
    }

    logger.info(
      {
        targetGroupId: TARGET_GROUP_ID,
        memoryCount: payloads.length,
      },
      "人格 seed memory 导入完成，并且已经可以通过 Graphiti 查询到",
    );
  } finally {
    await graphitiClient.stop();
  }
}

/**
 * loadSeedPackage 只负责读取磁盘文件并解析 JSON。
 * 它不做业务判断，也不直接连 Graphiti。
 *
 * 这样后面如果你换了另一份 persona 文件，
 * 可以很清楚地区分是“文件本身有问题”还是“导入流程有问题”。
 */
async function loadSeedPackage(filePath: string): Promise<PersonaSeedPackage> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as PersonaSeedPackage;

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.seed_memories)) {
    throw new Error('seed 文件格式不正确，顶层必须包含 "seed_memories" 数组');
  }

  if (parsed.seed_memories.length === 0) {
    throw new Error('seed 文件格式不正确，"seed_memories" 不能为空');
  }

  return parsed;
}

/**
 * buildMemoryPayloads 把 seed 文件里的每一条人格记忆，映射成 Graphiti add_memory 需要的参数。
 *
 * 这里故意忽略原文件里自带的 group_id，
 * 因为当前需求已经明确了：全部写进 persona_chen_jianing_core。
 */
function buildMemoryPayloads(seedPackage: PersonaSeedPackage): GraphitiMemoryInput[] {
  const packageSourceDescription = seedPackage.source_description?.trim() ?? "";

  return seedPackage.seed_memories.map((memory, index) => {
    const name = memory.name?.trim();
    if (!name) {
      throw new Error(`第 ${index + 1} 条 seed memory 缺少有效的 name`);
    }

    const source = memory.source?.trim() || "text";
    const episodeBody = normalizeEpisodeBody(memory, source, index);

    return {
      name,
      groupId: TARGET_GROUP_ID,
      source,
      sourceDescription: buildSourceDescription(packageSourceDescription, memory),
      episodeBody,
    };
  });
}

/**
 * 这里把顶层说明、memory id、重要性、tags 都拼进 sourceDescription，
 * 目的是让这条记忆的来源信息更完整一点。
 *
 * 这些字段不直接参与 Graphiti 的核心抽取，但对后面排查和理解来源很有帮助。
 */
function buildSourceDescription(
  packageSourceDescription: string,
  memory: PersonaSeedMemory,
): string {
  const parts: string[] = [];

  if (packageSourceDescription) {
    parts.push(packageSourceDescription);
  }

  if (memory.id?.trim()) {
    parts.push(`seed_memory_id=${memory.id.trim()}`);
  }

  if (memory.importance?.trim()) {
    parts.push(`importance=${memory.importance.trim()}`);
  }

  if (Array.isArray(memory.tags) && memory.tags.length > 0) {
    const normalizedTags = memory.tags
      .map((tag) => String(tag).trim())
      .filter((tag) => tag.length > 0);

    if (normalizedTags.length > 0) {
      parts.push(`tags=${normalizedTags.join(",")}`);
    }
  }

  return parts.join(" | ");
}

/**
 * 对于 text source，episode_body 应该是一段普通文本。
 * 如果未来某些 seed memory 改成 json source，这里也会自动把对象转成 JSON 字符串。
 */
function normalizeEpisodeBody(
  memory: PersonaSeedMemory,
  source: string,
  index: number,
): string {
  const rawBody = memory.episode_body;

  if (source === "json") {
    if (typeof rawBody === "string") {
      return rawBody.trim();
    }

    return JSON.stringify(rawBody, null, 2);
  }

  if (typeof rawBody !== "string" || rawBody.trim().length === 0) {
    throw new Error(`第 ${index + 1} 条 seed memory 缺少有效的 episode_body`);
  }

  return rawBody.trim();
}

/**
 * waitUntilEpisodesAreQueryable 会轮询 get_episodes。
 *
 * Graphiti 后台真正处理完成后，这些 name 才会出现在查询结果里。
 * 所以脚本不要只看 add_memory 返回成功，还要再确认“现在已经能查到了”。
 */
async function waitUntilEpisodesAreQueryable(
  graphitiClient: GraphitiClient,
  groupId: string,
  expectedNames: string[],
  logger: ReturnType<typeof createLogger>,
): Promise<boolean> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  const expectedNameSet = new Set(expectedNames);
  const queryLimit = Math.max(50, expectedNames.length * 3);

  while (Date.now() < deadline) {
    const episodes = await graphitiClient.getEpisodes(groupId, queryLimit);
    const existingNames = new Set(
      episodes
        .map((episode) => episode.name?.trim())
        .filter((name): name is string => Boolean(name)),
    );

    const missingNames = [...expectedNameSet].filter((name) => !existingNames.has(name));
    if (missingNames.length === 0) {
      return true;
    }

    logger.info(
      {
        targetGroupId: groupId,
        readyCount: expectedNameSet.size - missingNames.length,
        totalCount: expectedNameSet.size,
      },
      "Graphiti 仍在后台处理人格 seed memory，继续等待",
    );

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
