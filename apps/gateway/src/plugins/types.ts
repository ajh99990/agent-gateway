import type { Logger } from "pino";
import type { NormalizedMessage, WeFlowSseMessageEvent } from "../types.js";

export interface SendMessageInput {
  sessionId: string;
  groupName?: string;
  text: string;
  replyToMessage?: NormalizedMessage;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  keywords: string[];
  system: boolean;
}

export interface PluginCatalog {
  listPlugins(): PluginDescriptor[];
  findPluginByName(name: string): PluginDescriptor | undefined;
}

export interface PluginStateStore {
  isEnabled(sessionId: string, pluginId: string): Promise<boolean>;
  setEnabled(sessionId: string, pluginId: string, enabled: boolean): Promise<void>;
}

export interface PluginServices {
  sendMessage(input: SendMessageInput): Promise<void>;
  pluginState: PluginStateStore;
  plugins: PluginCatalog;
  logger: Logger;
  adminWechatIds: readonly string[];
}

export interface PluginContext {
  sessionId: string;
  groupName?: string;
  content: string;
  event: WeFlowSseMessageEvent;
  message: NormalizedMessage;
  services: PluginServices;
}

export interface PluginHandleResult {
  replyText?: string;
}

export interface GatewayPlugin {
  id: string;
  name: string;
  keywords: string[];
  system?: boolean;
  matches?(content: string): boolean;
  handle(context: PluginContext): Promise<PluginHandleResult>;
}

