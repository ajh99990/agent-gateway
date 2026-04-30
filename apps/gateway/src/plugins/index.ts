import type { GatewayPlugin } from "./types.js";
import { createCheckinPlugin } from "./checkin/checkin-plugin.js";
import { createPluginManagerPlugin } from "./system/plugin-manager-plugin.js";

export function createGatewayPlugins(): GatewayPlugin[] {
  return [
    createPluginManagerPlugin(),
    createCheckinPlugin(),
  ];
}

