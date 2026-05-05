import type { GatewayPlugin, PluginBootstrapContext } from "./types.js";
import { createCheckinPlugin } from "./checkin/checkin-plugin.js";
import { createExpeditionPlugin } from "./expedition/expedition-plugin.js";
import { createPluginManagerPlugin } from "./system/plugin-manager-plugin.js";

export function createGatewayPlugins(context: PluginBootstrapContext): GatewayPlugin[] {
  return [
    createPluginManagerPlugin(context),
    createCheckinPlugin(context),
    createExpeditionPlugin(context),
  ];
}
