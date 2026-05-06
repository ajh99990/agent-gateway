import type { GatewayPlugin, PluginDescriptor, PluginServices, PluginStateStore } from "./types.js";

export class PluginAdminError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface SessionPluginState extends PluginDescriptor {
  enabled: boolean;
  manageable: boolean;
}

export class PluginAdminService {
  public constructor(
    private readonly plugins: GatewayPlugin[],
    private readonly pluginState: PluginStateStore,
    private readonly services: PluginServices,
  ) {}

  public listPlugins(): PluginDescriptor[] {
    return this.plugins.map((plugin) => toDescriptor(plugin));
  }

  public async listSessionPluginStates(sessionId: string): Promise<SessionPluginState[]> {
    return Promise.all(
      this.plugins.map(async (plugin) => {
        const system = Boolean(plugin.system);
        return {
          ...toDescriptor(plugin),
          enabled: system
            ? true
            : await this.pluginState.isEnabled(sessionId, plugin.id, plugin.defaultEnabled),
          manageable: !system,
        };
      }),
    );
  }

  public async setPluginEnabled(
    sessionId: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<SessionPluginState> {
    const plugin = this.findPluginById(pluginId);
    if (!plugin) {
      throw new PluginAdminError(`Plugin not found: ${pluginId}`, 404);
    }

    if (plugin.system) {
      throw new PluginAdminError("System plugins cannot be enabled or disabled via admin API", 400);
    }

    const currentEnabled = await this.pluginState.isEnabled(
      sessionId,
      plugin.id,
      plugin.defaultEnabled,
    );
    if (currentEnabled === enabled) {
      return {
        ...toDescriptor(plugin),
        enabled,
        manageable: true,
      };
    }

    if (enabled) {
      await plugin.beforeEnable?.({
        sessionId,
        services: this.services,
      });
    } else {
      await plugin.beforeDisable?.({
        sessionId,
        services: this.services,
      });
    }

    await this.pluginState.setEnabled(sessionId, plugin.id, enabled);
    return {
      ...toDescriptor(plugin),
      enabled,
      manageable: true,
    };
  }

  private findPluginById(pluginId: string): GatewayPlugin | undefined {
    return this.plugins.find((plugin) => plugin.id === pluginId);
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
