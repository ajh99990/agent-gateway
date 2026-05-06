import type { AppConfig } from "../config.js";
import type {
  InboundMessageEvent,
  MessageHistoryProvider,
  NormalizedMessage,
} from "../types.js";
import type {
  GatewayPlugin,
  PluginCatalog,
  PluginCommand,
  PluginCommonServices,
  PluginDescriptor,
  PluginServices,
  SendMessageInput,
} from "./types.js";

interface PluginRouterOptions {
  config: AppConfig;
  historyProvider: MessageHistoryProvider;
  services: PluginCommonServices;
  plugins: GatewayPlugin[];
}

interface MessageKeyHint {
  localId?: number;
  senderUsername?: string;
}

interface CommandMatch {
  plugin: GatewayPlugin;
  command: PluginCommand;
}

export class PluginRouter {
  private readonly plugins: GatewayPlugin[];
  private readonly keywordIndex = new Map<string, CommandMatch>();
  private readonly catalog: PluginCatalog;
  private readonly services: PluginServices;

  public constructor(private readonly options: PluginRouterOptions) {
    this.plugins = [...options.plugins];
    this.catalog = this.createCatalog();
    this.services = {
      ...this.options.services,
      plugins: this.catalog,
    };
    this.buildKeywordIndex();
  }

  public getServices(): PluginServices {
    return this.services;
  }

  public async tryHandle(event: InboundMessageEvent): Promise<boolean> {
    const content = event.content?.trim();
    if (!content) {
      return false;
    }

    const match = this.findCommand(content);
    if (!match) {
      return false;
    }
    const { plugin, command } = match;

    if (!plugin.system) {
      const enabled = await this.services.pluginState.isEnabled(
        event.sessionId,
        plugin.id,
        plugin.defaultEnabled,
      );
      if (!enabled) {
        this.services.logger.debug(
          {
            sessionId: event.sessionId,
            pluginId: plugin.id,
            pluginName: plugin.name,
            content,
          },
          "消息命中插件关键词，但当前群已关闭该插件，继续走聊天 agent 链路",
        );
        return false;
      }
    }

    let message: NormalizedMessage | null = null;
    try {
      message = await this.loadMessageForEvent(event);
    } catch (error) {
      this.services.logger.error(
        {
          err: error,
          sessionId: event.sessionId,
          pluginId: plugin.id,
          pluginName: plugin.name,
          messageKey: event.messageKey,
          content,
        },
        "消息命中插件，但补拉完整消息失败，插件处理已短路",
      );
      await this.safeSendMessage({
        sessionId: event.sessionId,
        groupName: event.groupName,
        text: "暂时无法读取完整消息，插件处理失败。",
      });
      return true;
    }

    if (!message) {
      this.services.logger.warn(
        {
          sessionId: event.sessionId,
          pluginId: plugin.id,
          pluginName: plugin.name,
          messageKey: event.messageKey,
          content,
        },
        "消息命中插件，但无法定位完整消息，插件处理已短路",
      );
      await this.safeSendMessage({
        sessionId: event.sessionId,
        groupName: event.groupName,
        text: plugin.system
          ? "无法确认发送者身份，无法执行插件管理命令。"
          : "暂时无法确认这条消息，无法处理该指令。",
      });
      return true;
    }

    try {
      const result = await command.handle({
        sessionId: event.sessionId,
        groupName: event.groupName,
        content,
        event,
        message,
        services: this.services,
      });

      if (result.replyText?.trim()) {
        await this.safeSendMessage({
          sessionId: event.sessionId,
          groupName: event.groupName,
          text: result.replyText,
          replyToMessage: message,
          atSender: result.atSender,
          atWxids: result.atWxids,
        });
      }

      this.services.logger.info(
        {
          sessionId: event.sessionId,
          pluginId: plugin.id,
          pluginName: plugin.name,
          messageFingerprint: message.fingerprint,
        },
        "消息已由插件处理，跳过聊天 agent 链路",
      );
      return true;
    } catch (error) {
      this.services.logger.error(
        {
          err: error,
          sessionId: event.sessionId,
          pluginId: plugin.id,
          pluginName: plugin.name,
          messageFingerprint: message.fingerprint,
        },
        "插件处理消息失败，当前消息不会 fallback 到聊天 agent",
      );
      await this.safeSendMessage({
        sessionId: event.sessionId,
        groupName: event.groupName,
        text: "插件处理失败，请稍后再试。",
        replyToMessage: message,
      });
      return true;
    }
  }

  private async safeSendMessage(input: SendMessageInput): Promise<void> {
    try {
      await this.services.sendMessage(input);
    } catch (error) {
      this.services.logger.error(
        {
          err: error,
          sessionId: input.sessionId,
          groupName: input.groupName,
          replyToFingerprint: input.replyToMessage?.fingerprint,
        },
        "插件回复发送失败",
      );
    }
  }

  private findCommand(content: string): CommandMatch | undefined {
    for (const plugin of this.plugins) {
      if (!plugin.system) {
        continue;
      }

      const command = plugin.commands?.find((candidate) => commandMatches(candidate, content));
      if (command) {
        return { plugin, command };
      }
    }

    const keywordMatch = this.keywordIndex.get(content);
    if (keywordMatch) {
      return keywordMatch;
    }

    for (const plugin of this.plugins) {
      if (plugin.system) {
        continue;
      }

      const command = plugin.commands?.find((candidate) => candidate.matches?.(content));
      if (command) {
        return { plugin, command };
      }
    }

    return undefined;
  }

  private async loadMessageForEvent(event: InboundMessageEvent): Promise<NormalizedMessage | null> {
    if (event.normalizedMessage) {
      return event.normalizedMessage;
    }

    const page = await this.options.historyProvider.getRecentMessages({
      sessionId: event.sessionId,
      groupName: event.groupName,
      limit: this.options.config.weflowFetchLimit,
    });
    const messages = page.messages;
    if (messages.length === 0) {
      return null;
    }

    const hint = parseMessageKey(event.messageKey);
    if (hint.localId !== undefined) {
      const byLocalId = messages.find((message) => message.localId === hint.localId);
      if (byLocalId) {
        return byLocalId;
      }
    }

    const eventContent = event.content?.trim();
    const newestFirst = [...messages].reverse();
    return (
      newestFirst.find((message) => {
        const senderMatches =
          !hint.senderUsername || message.senderId === hint.senderUsername;
        const contentMatches =
          !eventContent ||
          message.content.trim() === eventContent ||
          message.rawContent.trim() === eventContent;
        return senderMatches && contentMatches;
      }) ?? null
    );
  }

  private createCatalog(): PluginCatalog {
    return {
      listPlugins: () => this.plugins.map((plugin) => toDescriptor(plugin)),
      findPluginByName: (name) => {
        const normalizedName = name.trim();
        if (!normalizedName) {
          return undefined;
        }

        const plugin = this.plugins.find((candidate) => candidate.name === normalizedName);
        return plugin ? toDescriptor(plugin) : undefined;
      },
      getPluginById: (pluginId) => this.plugins.find((plugin) => plugin.id === pluginId),
    };
  }

  private buildKeywordIndex(): void {
    for (const plugin of this.plugins) {
      if (!plugin.id.trim()) {
        throw new Error("插件 id 不能为空");
      }

      if (!plugin.name.trim()) {
        throw new Error(`插件 ${plugin.id} 缺少有效中文名`);
      }

      for (const command of plugin.commands ?? []) {
        for (const keyword of command.keywords ?? []) {
          const normalizedKeyword = keyword.trim();
          if (!normalizedKeyword) {
            throw new Error(`插件 ${plugin.name} 声明了空关键词`);
          }

          const existing = this.keywordIndex.get(normalizedKeyword);
          if (existing) {
            throw new Error(
              `插件关键词冲突："${normalizedKeyword}" 同时被 "${existing.plugin.name}" 和 "${plugin.name}" 声明`,
            );
          }

          this.keywordIndex.set(normalizedKeyword, { plugin, command });
        }
      }
    }
  }
}

function toDescriptor(plugin: GatewayPlugin): PluginDescriptor {
  return {
    id: plugin.id,
    name: plugin.name,
    keywords: getPluginKeywords(plugin),
    system: Boolean(plugin.system),
  };
}

function commandMatches(command: PluginCommand, content: string): boolean {
  return (
    Boolean(command.matches?.(content)) ||
    Boolean(command.keywords?.some((keyword) => keyword.trim() === content))
  );
}

function getPluginKeywords(plugin: GatewayPlugin): string[] {
  return Array.from(
    new Set(
      (plugin.commands ?? [])
        .flatMap((command) => command.keywords ?? [])
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    ),
  );
}

function parseMessageKey(messageKey: string): MessageKeyHint {
  const parts = messageKey.split(":");
  if (parts.length < 7 || parts[0] !== "server") {
    return {};
  }

  const localId = Number.parseInt(parts[4] ?? "", 10);
  return {
    localId: Number.isFinite(localId) ? localId : undefined,
    senderUsername: parts[5]?.trim() || undefined,
  };
}
