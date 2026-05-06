import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { GatewayDatabase } from "../db/client.js";
import type { JsonValue } from "../db/json.js";
import type { PointsService } from "../db/services/index.js";
import type { ScheduledJobDefinition, Scheduler } from "../scheduler/types.js";
import type { InboundMessageEvent, NormalizedMessage } from "../types.js";

export interface SendMessageInput {
  sessionId: string;
  groupName?: string;
  text: string;
  replyToMessage?: NormalizedMessage;
}

export interface OutboundMessageSender {
  sendMessage(input: SendMessageInput): Promise<void>;
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
  getPluginById(pluginId: string): GatewayPlugin | undefined;
}

export interface PluginStateStore {
  isEnabled(sessionId: string, pluginId: string, defaultEnabled?: boolean): Promise<boolean>;
  setEnabled(sessionId: string, pluginId: string, enabled: boolean): Promise<void>;
  listEnabledSessions(pluginId: string, defaultEnabled?: boolean): Promise<PluginEnabledSession[]>;
}

export interface PluginEnabledSession {
  sessionId: string;
  groupName?: string;
  lastSeenAt: Date;
}

export interface PluginDataStore {
  getValue<T extends JsonValue = JsonValue>(
    pluginId: string,
    sessionId: string,
    key: string,
  ): Promise<T | null>;
  setValue(pluginId: string, sessionId: string, key: string, value: JsonValue): Promise<void>;
  deleteValue(pluginId: string, sessionId: string, key: string): Promise<void>;
  listKeys(pluginId: string, sessionId: string, keyPrefix?: string): Promise<string[]>;
}

export type PluginOperationRunScope = "global" | "session" | "sender";

export type PluginOperationRunStatus = "running" | "succeeded" | "failed";

export interface PluginOperationRunRecord {
  id: number;
  pluginId: string;
  scope: PluginOperationRunScope;
  scopeId: string;
  operationKey: string;
  status: PluginOperationRunStatus;
  attempts: number;
  metadata?: JsonValue;
  errorMessage?: string;
  startedAt: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StartPluginOperationRunInput {
  pluginId: string;
  scope: PluginOperationRunScope;
  scopeId?: string;
  operationKey: string;
  metadata?: JsonValue;
  retryFailed?: boolean;
}

export interface StartPluginOperationRunResult {
  started: boolean;
  run: PluginOperationRunRecord;
  previousStatus?: PluginOperationRunStatus;
}

export interface PluginOperationRunLookup {
  pluginId: string;
  scope: PluginOperationRunScope;
  scopeId?: string;
  operationKey: string;
}

export interface PluginOperationRunStore {
  tryStart(input: StartPluginOperationRunInput): Promise<StartPluginOperationRunResult>;
  markSucceeded(id: number, metadata?: JsonValue): Promise<PluginOperationRunRecord>;
  markFailed(id: number, error: unknown, metadata?: JsonValue): Promise<PluginOperationRunRecord>;
  get(input: PluginOperationRunLookup): Promise<PluginOperationRunRecord | null>;
}

export interface PluginCommonServices {
  sendMessage(input: SendMessageInput): Promise<void>;
  pluginState: PluginStateStore;
  pluginData: PluginDataStore;
  operationRuns: PluginOperationRunStore;
  points: PointsService;
  scheduler: Scheduler;
  logger: Logger;
  adminWechatIds: readonly string[];
}

export interface PluginServices extends PluginCommonServices {
  plugins: PluginCatalog;
}

export interface PluginBootstrapContext {
  config: AppConfig;
  db: GatewayDatabase;
  services: PluginCommonServices;
}

export interface PluginContext {
  sessionId: string;
  groupName?: string;
  content: string;
  event: InboundMessageEvent;
  message: NormalizedMessage;
  services: PluginServices;
}

export interface PluginHandleResult {
  replyText?: string;
}

export interface PluginToggleContext {
  sessionId: string;
  groupName?: string;
  services: PluginServices;
}

export interface PluginToggleResult {
  replyText?: string;
}

export interface GatewayPlugin {
  id: string;
  name: string;
  description?: string;
  defaultEnabled?: boolean;
  system?: boolean;
  commands?: PluginCommand[];
  scheduledJobs?: ScheduledJobDefinition[];
  beforeEnable?(context: PluginToggleContext): Promise<PluginToggleResult | void>;
  beforeDisable?(context: PluginToggleContext): Promise<PluginToggleResult | void>;
}

export interface PluginCommand {
  id?: string;
  name?: string;
  keywords?: string[];
  matches?(content: string): boolean;
  handle(context: PluginContext): Promise<PluginHandleResult>;
}
