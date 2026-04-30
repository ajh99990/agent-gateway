import type { GatewayPlugin, PluginDescriptor, PluginStateStore } from "./types.js";

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
          enabled: system ? true : await this.pluginState.isEnabled(sessionId, plugin.id),
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
    keywords: [...plugin.keywords],
    system: Boolean(plugin.system),
  };
}

