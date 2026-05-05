import { RedisStore } from "../infra/redis-store.js";
import type { PluginStateStore as PluginStateStoreContract } from "./types.js";

export class RedisPluginStateStore implements PluginStateStoreContract {
  public constructor(private readonly redis: RedisStore) {}

  public async isEnabled(sessionId: string, pluginId: string): Promise<boolean> {
    const raw = await this.redis.getValue(this.stateKey(sessionId, pluginId));
    if (raw === null) {
      return true;
    }

    return raw === "1";
  }

  public async setEnabled(sessionId: string, pluginId: string, enabled: boolean): Promise<void> {
    await this.redis.setValue(this.stateKey(sessionId, pluginId), enabled ? "1" : "0");
  }

  private stateKey(sessionId: string, pluginId: string): string {
    return `plugin:${sessionId}:${pluginId}:enabled`;
  }
}
