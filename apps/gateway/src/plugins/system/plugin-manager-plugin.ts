import type {
  GatewayPlugin,
  PluginBootstrapContext,
  PluginContext,
  PluginHandleResult,
} from "../types.js";

const LIST_COMMAND = "插件列表";
const ENABLE_PREFIX = "开启插件 ";
const DISABLE_PREFIX = "关闭插件 ";

export function createPluginManagerPlugin(_context: PluginBootstrapContext): GatewayPlugin {
  return {
    id: "plugin-manager",
    name: "插件管理",
    keywords: [LIST_COMMAND],
    system: true,
    matches(content) {
      return (
        content === LIST_COMMAND ||
        content.startsWith(ENABLE_PREFIX) ||
        content.startsWith(DISABLE_PREFIX)
      );
    },
    async handle(context) {
      if (!isAdmin(context)) {
        return {
          replyText: "你没有权限管理插件。",
        };
      }

      if (context.content === LIST_COMMAND) {
        return listPlugins(context);
      }

      if (context.content.startsWith(ENABLE_PREFIX)) {
        return setPluginEnabled(context, ENABLE_PREFIX, true);
      }

      if (context.content.startsWith(DISABLE_PREFIX)) {
        return setPluginEnabled(context, DISABLE_PREFIX, false);
      }

      return {
        replyText: "不支持的插件管理命令。",
      };
    },
  };
}

function isAdmin(context: PluginContext): boolean {
  const adminIds = context.services.adminWechatIds;
  if (adminIds.length === 0) {
    return false;
  }

  return adminIds.includes(context.message.senderId);
}

async function listPlugins(context: PluginContext): Promise<PluginHandleResult> {
  const plugins = context.services.plugins
    .listPlugins()
    .filter((plugin) => !plugin.system);

  if (plugins.length === 0) {
    return {
      replyText: "当前没有可管理的业务插件。",
    };
  }

  const lines = await Promise.all(
    plugins.map(async (plugin) => {
      const enabled = await context.services.pluginState.isEnabled(context.sessionId, plugin.id);
      return `${plugin.name}：${enabled ? "已开启" : "已关闭"}`;
    }),
  );

  return {
    replyText: lines.join("\n"),
  };
}

async function setPluginEnabled(
  context: PluginContext,
  prefix: string,
  enabled: boolean,
): Promise<PluginHandleResult> {
  const pluginName = context.content.slice(prefix.length).trim();
  if (!pluginName) {
    return {
      replyText: `请指定插件名，例如：${prefix}签到`,
    };
  }

  const plugin = context.services.plugins.findPluginByName(pluginName);
  if (!plugin) {
    return {
      replyText: `没有找到名为“${pluginName}”的插件。`,
    };
  }

  if (plugin.system) {
    return {
      replyText: "系统插件不能通过群聊命令开启或关闭。",
    };
  }

  const currentEnabled = await context.services.pluginState.isEnabled(context.sessionId, plugin.id);
  if (currentEnabled === enabled) {
    return {
      replyText: `${plugin.name}插件已经是${enabled ? "开启" : "关闭"}状态。`,
    };
  }

  const runtimePlugin = context.services.plugins.getPluginById(plugin.id);
  const hookResult = enabled
    ? await runtimePlugin?.beforeEnable?.({
        sessionId: context.sessionId,
        groupName: context.groupName,
        services: context.services,
      })
    : await runtimePlugin?.beforeDisable?.({
        sessionId: context.sessionId,
        groupName: context.groupName,
        services: context.services,
      });

  await context.services.pluginState.setEnabled(context.sessionId, plugin.id, enabled);
  return {
    replyText: hookResult?.replyText ?? `已${enabled ? "开启" : "关闭"}${plugin.name}插件。`,
  };
}
