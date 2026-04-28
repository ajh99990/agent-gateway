import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import type { GraphitiWriteBatch } from "./types.js";

const ADD_MEMORY_TOOL_NAME = "add_memory";
const GET_EPISODES_TOOL_NAME = "get_episodes";
const CLEAR_GRAPH_TOOL_NAME = "clear_graph";

export interface GraphitiMemoryInput {
  name: string;
  groupId: string;
  source: string;
  sourceDescription: string;
  episodeBody: string;
}

export interface GraphitiEpisodeRecord {
  uuid?: string;
  name?: string;
  content?: string;
  group_id?: string;
  source?: string;
  source_description?: string;
  created_at?: string;
}

/**
 * GraphitiClient 负责把当前项目整理好的记忆写入 Graphiti MCP，
 * 以及在离线脚本里查询某个 group 的 episode 状态。
 *
 * 这层故意保持轻量：
 * - 启动时连接一次 Graphiti MCP
 * - 通过固定工具名调用 add_memory / get_episodes / clear_graph
 * - 不在运行时做自动重连，出错就直接暴露给上层
 */
export class GraphitiClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private stopping = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  public isEnabled(): boolean {
    return Boolean(this.config.graphitiMcpUrl);
  }

  /**
   * start 在网关或导入脚本启动阶段执行。
   * 如果没有配置 Graphiti，就直接跳过；如果配置了，就在这里把 MCP 连接建好，
   * 后面所有 addMemory / getEpisodes 调用都复用这条连接。
   */
  public async start(): Promise<void> {
    if (!this.config.graphitiMcpUrl || this.client || this.transport) {
      return;
    }

    this.stopping = false;

    const client = new Client(
      {
        name: "event-gateway",
        version: "0.1.0",
      },
      {
        capabilities: {},
      },
    );

    const transport = new StreamableHTTPClientTransport(new URL(this.config.graphitiMcpUrl));

    client.onerror = (error) => {
      if (this.stopping && isAbortLikeError(error)) {
        return;
      }

      this.logger.error({ err: error }, "Graphiti MCP 客户端出现错误");
    };

    transport.onerror = (error) => {
      if (this.stopping && isAbortLikeError(error)) {
        return;
      }

      this.logger.error({ err: error }, "Graphiti MCP 传输层出现错误");
    };

    transport.onclose = () => {
      this.client = undefined;
      this.transport = undefined;

      if (!this.stopping) {
        this.logger.warn("Graphiti MCP 连接已关闭；当前版本不会自动重连");
      }
    };

    try {
      await client.connect(transport, {
        timeout: this.config.graphitiTimeoutMs,
      });

      const tools = await client.listTools(undefined, {
        timeout: this.config.graphitiTimeoutMs,
      });

      if (!tools.tools.some((tool) => tool.name === ADD_MEMORY_TOOL_NAME)) {
        throw new Error(
          `Graphiti MCP 缺少 ${ADD_MEMORY_TOOL_NAME} 工具。当前工具: ${tools.tools
            .map((tool) => tool.name)
            .join(", ")}`,
        );
      }

      this.client = client;
      this.transport = transport;

      this.logger.info(
        {
          graphitiMcpUrl: this.config.graphitiMcpUrl,
          addMemoryToolName: ADD_MEMORY_TOOL_NAME,
        },
        "已连上 Graphiti MCP 服务",
      );
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * stop 在优雅退出时调用。
   * 这里只做一件事：关闭当前 MCP 连接。
   */
  public async stop(): Promise<void> {
    this.stopping = true;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;

    if (!transport) {
      return;
    }

    try {
      await transport.close();
    } catch (error) {
      this.logger.warn({ err: error }, "关闭 Graphiti MCP 连接时出现异常");
    }
  }

  /**
   * addMemory 是更通用的写入入口。
   * 只要上层已经准备好了 name / group_id / source / episode_body，
   * 不管它来自群消息、历史聊天还是人格 seed，都可以复用这里。
   */
  public async addMemory(memory: GraphitiMemoryInput): Promise<string> {
    if (!this.isEnabled()) {
      return "";
    }

    const client = this.requireClient();
    const result = await client.callTool(
      {
        name: ADD_MEMORY_TOOL_NAME,
        arguments: {
          name: memory.name,
          group_id: memory.groupId,
          source: memory.source,
          source_description: memory.sourceDescription,
          episode_body: memory.episodeBody,
        },
      },
      CallToolResultSchema,
      {
        timeout: this.config.graphitiTimeoutMs,
      },
    );

    const responseText = getToolResponseText(result);
    if (result.isError) {
      throw new Error(responseText || "Graphiti MCP add_memory returned isError=true");
    }

    return responseText;
  }

  /**
   * getEpisodes 主要给离线导入脚本做轮询确认。
   * Graphiti 的 add_memory 是异步处理的，所以脚本刚提交完之后，
   * 需要靠 get_episodes 确认这些 episode 是否已经变成可查询状态。
   */
  public async getEpisodes(
    groupId: string,
    maxEpisodes = 50,
  ): Promise<GraphitiEpisodeRecord[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const client = this.requireClient();
    const result = await client.callTool(
      {
        name: GET_EPISODES_TOOL_NAME,
        arguments: {
          group_ids: [groupId],
          max_episodes: maxEpisodes,
        },
      },
      CallToolResultSchema,
      {
        timeout: this.config.graphitiTimeoutMs,
      },
    );

    const responseText = getToolResponseText(result);
    if (result.isError) {
      throw new Error(responseText || "Graphiti MCP get_episodes returned isError=true");
    }

    const parsed = parseToolJsonResponse(responseText);
    const episodes = parsed.episodes;
    if (!Array.isArray(episodes)) {
      return [];
    }

    return episodes.filter(
      (episode): episode is GraphitiEpisodeRecord =>
        typeof episode === "object" && episode !== null,
    );
  }

  /**
   * clearGroup 主要给“重播种固定记忆”的脚本使用。
   * 如果你反复导入同一个 persona group，可以先 clear 一次，避免 episode 重复累积。
   */
  public async clearGroup(groupId: string): Promise<string> {
    if (!this.isEnabled()) {
      return "";
    }

    const client = this.requireClient();
    const result = await client.callTool(
      {
        name: CLEAR_GRAPH_TOOL_NAME,
        arguments: {
          group_id: groupId,
        },
      },
      CallToolResultSchema,
      {
        timeout: this.config.graphitiTimeoutMs,
      },
    );

    const responseText = getToolResponseText(result);
    if (result.isError) {
      throw new Error(responseText || "Graphiti MCP clear_graph returned isError=true");
    }

    return responseText;
  }

  /**
   * addMessages 仍然保留给 event-gateway 主链路使用。
   * 它负责把一小批 newMessages 整理成一条 Graphiti memory，
   * 再转交给更通用的 addMemory。
   */
  public async addMessages(batch: GraphitiWriteBatch): Promise<void> {
    if (!this.isEnabled() || batch.messages.length === 0) {
      return;
    }

    const sortedMessages = [...batch.messages].sort((left, right) => left.localId - right.localId);
    const firstMessage = sortedMessages[0]!;
    const lastMessage = sortedMessages.at(-1)!;
    const batchId = `wechat-batch:${batch.sessionId}:${firstMessage.localId}-${lastMessage.localId}`;
    const graphitiGroupId = buildGraphitiGroupId(
      this.config.graphitiGroupPrefix,
      batch.sessionId,
    );

    this.logger.debug(
      {
        runId: batch.runId,
        sessionId: batch.sessionId,
        graphitiGroupId,
        count: sortedMessages.length,
        batchId,
        triggerReason: batch.triggerReason,
      },
      "开始把本轮新消息通过 Graphiti MCP 写入记忆库",
    );

    const responseText = await this.addMemory({
      name: batchId,
      groupId: graphitiGroupId,
      source: "json",
      sourceDescription: `wechat quiet-window batch (${batch.triggerReason})`,
      episodeBody: JSON.stringify({
        sessionId: batch.sessionId,
        groupName: batch.groupName,
        messages: sortedMessages.map((message) => ({
          sender: message.senderName,
          timestamp: message.timestamp,
          content: message.content,
        })),
      }),
    });

    this.logger.debug(
      {
        runId: batch.runId,
        sessionId: batch.sessionId,
        graphitiGroupId,
        batchId,
        responseText,
      },
      "Graphiti MCP 已接收本轮记忆写入任务",
    );
  }

  private requireClient(): Client {
    const client = this.client;
    if (!client) {
      throw new Error("Graphiti MCP 尚未连接，请先在启动阶段调用 graphitiClient.start()");
    }

    return client;
  }
}

function isAbortLikeError(error: Error): boolean {
  return error.name === "AbortError" || error.message.includes("AbortError");
}

function getToolResponseText(result: unknown): string {
  const maybeResult =
    typeof result === "object" && result !== null ? (result as { content?: unknown }) : {};
  const content = Array.isArray(maybeResult.content)
    ? (maybeResult.content as Array<{ type: string; text?: string }>)
    : [];
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && "text" in item && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function parseToolJsonResponse(text: string): Record<string, unknown> {
  if (!text.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Graphiti 当前对 group_id 有字符限制：
 * 只允许字母、数字、下划线和短横线。
 *
 * 所以像微信 sessionId 这种自带 `@chatroom` 的原始标识，
 * 不能直接拿去当 Graphiti group_id，必须先做一次规范化。
 */
export function buildGraphitiGroupId(prefix: string, sessionId: string): string {
  return `${prefix}${sessionId}`
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}
