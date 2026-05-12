import { randomInt } from "node:crypto";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../db/client.js";
import type { PointsService } from "../../db/services/index.js";
import { getBusinessDateKey, getDailyCutoffAt, isBeforeDailyCutoff } from "../../time.js";
import type {
  PluginContext,
  PluginDataStore,
  PluginHandleResult,
  PluginOperationRunStore,
  PluginStateStore,
  SendMessageInput,
} from "../types.js";
import {
  ANNOUNCEMENT_TITLES,
  BOSS_NAMES,
  BOOST_REMINDER_TEXTS,
  CRAZY_DEATH_REASONS,
  DEATH_REASONS,
  EFFECT_LABELS,
  GREEDY_DEATH_REASONS,
  RARITY_LABELS,
  RELIC_NAMES,
  SPECIAL_EVENT_TEMPLATES,
  STRATEGY_LABELS,
  renderTemplate,
} from "./expedition-content.js";
import {
  collectRelicBonuses,
} from "./expedition-modifiers.js";
import type { ExpeditionModifier } from "./expedition-modifiers.js";
import {
  RANDOM_EVENT_DEFINITIONS,
} from "./expedition-random-events.js";
import {
  STRATEGY_CONFIG,
  modifierSourcesToDetails,
  modifierTotalsToDetails,
  resolveExpeditionSettlement,
} from "./expedition-resolution.js";
import { ExpeditionStore } from "./expedition-store.js";
import type {
  ExpeditionEntryPlan,
  ExpeditionEntryRecord,
  ExpeditionCastRecord,
  ExpeditionCastType,
  ExpeditionOutcome,
  ExpeditionPlayerRecord,
  ExpeditionRandomEventEffectValue,
  ExpeditionRandomEventRecord,
  ExpeditionRelicEffectType,
  ExpeditionRelicEffectValue,
  ExpeditionRelicRarity,
  ExpeditionRelicRecord,
  ExpeditionReportRecord,
  ExpeditionSettlementSummary,
  ExpeditionStrategy,
} from "./expedition-types.js";
import {
  EXPEDITION_PLUGIN_ID,
  EXPEDITION_SETTLEMENT_CUTOFF,
  EXPEDITION_TIMEZONE,
} from "./expedition-types.js";

const MIN_STAKE = 10;
const MAX_STAKE_RATE = 0.8;
const INITIAL_BOSS_POLLUTION = 1_000_000;
const BOOST_WINDOW_START = "17:40";
const RANDOM_EVENT_WINDOW_START = "10:00";
const RANDOM_EVENT_WINDOW_END = "17:30";
const RANDOM_EVENT_SLOT_INTERVAL_MINUTES = 10;
const MAX_CASTS_PER_DAY = 3;
const IDLE_EVENT_REWARD_POINTS = 10;

const RELIC_EFFECT_VALUES: Record<ExpeditionRelicRarity, Record<ExpeditionRelicEffectType, ExpeditionRelicEffectValue>> = {
  common: {
    survival: { survivalBonusBp: 100 },
    greed: { multiplierBonusBp: 500 },
    dive: { diveBonus: 1 },
    luck: { dropRateBonusBp: 200, qualityBonus: 5 },
    purification: { purificationBonusBp: 1000 },
    curse: { multiplierBonusBp: 1500, curseSurvivalPenaltyBp: 200 },
  },
  rare: {
    survival: { survivalBonusBp: 300 },
    greed: { multiplierBonusBp: 1500 },
    dive: { diveBonus: 2 },
    luck: { dropRateBonusBp: 500, qualityBonus: 15 },
    purification: { purificationBonusBp: 2500 },
    curse: { multiplierBonusBp: 3500, curseSurvivalPenaltyBp: 500 },
  },
  epic: {
    survival: { survivalBonusBp: 600 },
    greed: { multiplierBonusBp: 3000 },
    dive: { diveBonus: 3 },
    luck: { dropRateBonusBp: 900, qualityBonus: 35 },
    purification: { purificationBonusBp: 6000 },
    curse: { multiplierBonusBp: 7000, curseSurvivalPenaltyBp: 1000 },
  },
  legendary: {
    survival: { survivalBonusBp: 1000 },
    greed: { multiplierBonusBp: 6000 },
    dive: { diveBonus: 5 },
    luck: { dropRateBonusBp: 1500, qualityBonus: 80 },
    purification: { purificationBonusBp: 12000 },
    curse: { multiplierBonusBp: 15000, curseSurvivalPenaltyBp: 1800 },
  },
};

interface ExpeditionServiceOptions {
  db: GatewayDatabase;
  store: ExpeditionStore;
  points: PointsService;
  pluginState: PluginStateStore;
  pluginData: PluginDataStore;
  operationRuns: PluginOperationRunStore;
  sendMessage(input: SendMessageInput): Promise<void>;
  logger: Logger;
}

interface SettlementResult {
  report: ExpeditionReportRecord;
  relic?: ExpeditionRelicRecord;
}

export class ExpeditionService {
  public constructor(private readonly options: ExpeditionServiceOptions) {}

  public async handleMessage(context: PluginContext): Promise<PluginHandleResult> {
    const content = context.content.trim();
    if (content === "远征指令") {
      return this.replyToSender(expeditionCommandMenuText());
    }

    if (content === "取消远征") {
      return this.replyToSender(await this.cancelEntry(context));
    }

    if (content === "加码") {
      return this.replyToSender(await this.boostEntry(context));
    }

    if (content.startsWith("祝福 ")) {
      return this.replyToSender(await this.castSpell(context, "blessing"));
    }

    if (content.startsWith("毒奶 ")) {
      return this.replyToSender(await this.castSpell(context, "jinx"));
    }

    if (content === "我的施法") {
      return this.replyToSender(await this.getMyCasts(context));
    }

    if (content === "我的战报") {
      return this.replyToSender(await this.getMyReport(context));
    }

    if (content === "我的遗物") {
      return this.replyToSender(await this.getMyRelics(context));
    }

    if (content === "远征排行") {
      return this.replyToSender(await this.getRanking(context));
    }

    return this.replyToSender(await this.registerEntry(context));
  }

  private replyToSender(replyText: string): PluginHandleResult {
    return {
      replyText,
      atSender: true,
    };
  }

  public async beforeDisable(sessionId: string, groupName: string | undefined): Promise<string> {
    const now = new Date();
    if (!isBeforeDailyCutoff(now, EXPEDITION_SETTLEMENT_CUTOFF, EXPEDITION_TIMEZONE)) {
      return "远征插件已关闭。今日远征已经锁定，已报名的远征不会自动取消。";
    }

    const dateKey = getBusinessDateKey(now, EXPEDITION_TIMEZONE);
    const entries = await this.options.store.listRegisteredEntries(sessionId, dateKey);
    const cancellableEntries = entries.filter((entry) => !entry.boosted);
    const lockedEntries = entries.filter((entry) => entry.boosted);
    if (entries.length === 0) {
      return "远征插件已关闭。";
    }
    if (cancellableEntries.length === 0) {
      return "远征插件已关闭。今日已加码的远征已经锁定，不会自动取消。";
    }

    await this.options.db.transaction(async (tx) => {
      const store = this.options.store.withTransaction(tx);
      const points = this.options.points.withTransaction(tx);
      for (const entry of cancellableEntries) {
        await points.earn({
          sessionId,
          senderId: entry.senderId,
          amount: entry.stake,
          source: EXPEDITION_PLUGIN_ID,
          description: "关闭远征插件返还投入",
          operatorId: "system",
          idempotencyKey: ledgerKey(entry, "disable-refund"),
          metadata: {
            pluginId: EXPEDITION_PLUGIN_ID,
            action: "disable_refund",
            dateKey,
          },
        });
        await store.cancelEntry(entry);
      }
    });

    const lockedText = lockedEntries.length > 0
      ? `\n另有 ${lockedEntries.length} 个已加码远征已经锁定，未自动取消。`
      : "";
    return `远征插件已关闭，已自动取消 ${cancellableEntries.length} 个今日报名并返还投入积分。${lockedText}`;
  }

  public async runDailySettlement(timestamp: string): Promise<void> {
    const dateKey = getBusinessDateKey(timestamp, EXPEDITION_TIMEZONE);
    const sessions = await this.options.store.listRegisteredSessions(dateKey);
    for (const session of sessions) {
      await this.runSessionSettlement(session.sessionId, session.groupName, dateKey);
    }
  }

  public async runBoostReminder(timestamp: string): Promise<void> {
    const dateKey = getBusinessDateKey(timestamp, EXPEDITION_TIMEZONE);
    const sessions = await this.options.pluginState.listEnabledSessions(EXPEDITION_PLUGIN_ID, true);
    const errors: unknown[] = [];

    for (const session of sessions) {
      const operation = await this.options.operationRuns.tryStart({
        pluginId: EXPEDITION_PLUGIN_ID,
        scope: "session",
        scopeId: session.sessionId,
        operationKey: boostReminderOperationKey(dateKey),
        metadata: { dateKey },
        retryFailed: true,
      });

      if (!operation.started) {
        continue;
      }

      try {
        await this.options.sendMessage({
          sessionId: session.sessionId,
          groupName: session.groupName,
          text: sample(BOOST_REMINDER_TEXTS),
        });
        await this.options.operationRuns.markSucceeded(operation.run.id, { dateKey });
      } catch (error) {
        await this.options.operationRuns.markFailed(operation.run.id, error, { dateKey });
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new Error(`加码开放提醒发送失败：${errors.length} 个群发送失败`);
    }
  }

  public async runRandomEventTick(timestamp: string): Promise<void> {
    const tickDate = new Date(timestamp);
    if (!isWithinRandomEventWindow(tickDate)) {
      return;
    }

    const dateKey = getBusinessDateKey(tickDate, EXPEDITION_TIMEZONE);
    const slotKey = getLocalTimeKey(tickDate, EXPEDITION_TIMEZONE);
    const sessions = await this.options.pluginState.listEnabledSessions(EXPEDITION_PLUGIN_ID, true);
    const errors: unknown[] = [];

    for (const session of sessions) {
      const plan = await this.getOrCreateRandomEventPlan(session.sessionId, dateKey);
      if (!plan.slots.includes(slotKey)) {
        continue;
      }

      const operation = await this.options.operationRuns.tryStart({
        pluginId: EXPEDITION_PLUGIN_ID,
        scope: "session",
        scopeId: session.sessionId,
        operationKey: randomEventOperationKey(dateKey, slotKey),
        metadata: { dateKey, slotKey },
        retryFailed: true,
      });

      if (!operation.started) {
        continue;
      }

      try {
        const result = await this.dispatchRandomEvent(session.sessionId, session.groupName, dateKey, slotKey);
        await this.options.operationRuns.markSucceeded(operation.run.id, {
          dateKey,
          slotKey,
          skipped: !result.dispatched,
          ...(result.eventKey ? { eventKey: result.eventKey } : {}),
        });
      } catch (error) {
        await this.options.operationRuns.markFailed(operation.run.id, error, { dateKey, slotKey });
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new Error(`远征随机事件发送失败：${errors.length} 个群发送失败`);
    }
  }

  private async getOrCreateRandomEventPlan(
    sessionId: string,
    dateKey: string,
  ): Promise<{ dateKey: string; slots: string[] }> {
    const key = randomEventPlanKey(dateKey);
    const existing = await this.options.pluginData.getValue<{
      dateKey?: string;
      slots?: string[];
    }>(EXPEDITION_PLUGIN_ID, sessionId, key);

    if (
      existing?.dateKey === dateKey &&
      Array.isArray(existing.slots) &&
      existing.slots.every((slot) => typeof slot === "string")
    ) {
      return { dateKey, slots: existing.slots };
    }

    const slots = pickRandomEventSlots();
    const plan = { dateKey, slots };
    await this.options.pluginData.setValue(EXPEDITION_PLUGIN_ID, sessionId, key, plan);
    return plan;
  }

  private async dispatchRandomEvent(
    sessionId: string,
    groupName: string | undefined,
    dateKey: string,
    slotKey: string,
  ): Promise<{ dispatched: boolean; eventKey?: string }> {
    const entries = await this.options.store.listRegisteredEntries(sessionId, dateKey);
    const todayParticipantIds = new Set(entries.map((entry) => entry.senderId));
    const yesterdayParticipants = await this.options.store.listHistoricalParticipants({
      sessionId,
      dateKey: previousDateKey(dateKey),
    });
    const idleAlreadyTriggered = await this.options.store.hasIdleRandomEvent(sessionId, dateKey);
    const idleCandidates = idleAlreadyTriggered
      ? []
      : yesterdayParticipants.filter((participant) => !todayParticipantIds.has(participant.senderId));
    const ordinaryEvents = entries.length > 0
      ? RANDOM_EVENT_DEFINITIONS.filter((event) => event.type !== "idle")
      : [];
    const idleEvents = idleCandidates.length > 0
      ? RANDOM_EVENT_DEFINITIONS.filter((event) => event.type === "idle")
      : [];
    const candidates = [...ordinaryEvents, ...idleEvents];

    if (candidates.length === 0) {
      return { dispatched: false };
    }

    const event = sample(candidates);
    const eventKey = `${slotKey}:${event.key}`;

    if (event.type === "idle") {
      const target = sample(idleCandidates);
      const messageText = renderTemplate(event.template, { player: target.senderName });
      await this.options.db.transaction(async (tx) => {
        const store = this.options.store.withTransaction(tx);
        const points = this.options.points.withTransaction(tx);
        await points.earn({
          sessionId,
          senderId: target.senderId,
          amount: event.effect?.rewardPoints ?? IDLE_EVENT_REWARD_POINTS,
          source: EXPEDITION_PLUGIN_ID,
          description: "远征留守事件奖励",
          operatorId: "system",
          idempotencyKey: `${EXPEDITION_PLUGIN_ID}:${dateKey}:${sessionId}:${target.senderId}:idle-event:${slotKey}`,
          metadata: {
            pluginId: EXPEDITION_PLUGIN_ID,
            action: "idle_random_event_reward",
            dateKey,
            slotKey,
            eventKey: event.key,
          },
        });
        await store.insertRandomEvent({
          sessionId,
          groupName,
          dateKey,
          eventKey,
          eventType: event.type,
          title: event.title,
          messageText,
          targetSenderId: target.senderId,
          targetSenderName: target.senderName,
          effectValue: event.effect,
        });
      });
      await this.options.sendMessage({ sessionId, groupName, text: messageText });
      return { dispatched: true, eventKey };
    }

    if (event.type === "flavor") {
      await this.options.store.insertRandomEvent({
        sessionId,
        groupName,
        dateKey,
        eventKey,
        eventType: event.type,
        title: event.title,
        messageText: event.template,
        effectValue: event.effect,
      });
      await this.options.sendMessage({ sessionId, groupName, text: event.template });
      return { dispatched: true, eventKey };
    }

    const affectedEntries = event.type === "targeted"
      ? [sample(entries)]
      : entries;
    const messagePlayer = affectedEntries[0]?.senderName ?? "";
    const messageText = renderTemplate(event.template, { player: messagePlayer });

    await this.options.db.transaction(async (tx) => {
      const store = this.options.store.withTransaction(tx);
      for (const entry of affectedEntries) {
        await store.insertRandomEvent({
          sessionId,
          groupName,
          dateKey,
          eventKey,
          eventType: event.type,
          title: event.title,
          messageText,
          targetSenderId: entry.senderId,
          targetSenderName: entry.senderName,
          targetEntryId: entry.id,
          targetEntryRevision: entry.revision,
          effectValue: event.effect,
        });
      }
    });
    await this.options.sendMessage({ sessionId, groupName, text: messageText });
    return { dispatched: true, eventKey };
  }

  private async registerEntry(context: PluginContext): Promise<string> {
    const command = parseEntryCommand(context.content);
    if (!command) {
      return formatErrorText();
    }

    const messageDate = new Date(context.message.createdAtUnixMs);
    if (!isBeforeDailyCutoff(messageDate, EXPEDITION_SETTLEMENT_CUTOFF, EXPEDITION_TIMEZONE)) {
      return closedText();
    }

    const dateKey = getBusinessDateKey(messageDate, EXPEDITION_TIMEZONE);
    const result = await this.options.db.transaction(async (tx) => {
      const store = this.options.store.withTransaction(tx);
      const points = this.options.points.withTransaction(tx);
      const existing = await store.findEntry(context.sessionId, dateKey, context.message.senderId);
      if (existing?.status === "settled") {
        return {
          ok: false as const,
          message: closedText(),
        };
      }
      if (existing?.status === "registered" && existing.boosted) {
        return {
          ok: false as const,
          message: lockedModifyText(),
        };
      }

      const balance = await points.getBalance(context.sessionId, context.message.senderId);
      const refundableStake = existing?.status === "registered" ? existing.stake : 0;
      const effectiveBalance = balance.balance + refundableStake;
      const plan = resolveStake(command, effectiveBalance);

      if (!plan.ok) {
        return plan;
      }

      if (existing?.status === "registered" && samePlan(existing, plan.plan)) {
        return {
          ok: true as const,
          unchanged: true,
          entry: existing,
          balanceAfter: balance.balance,
        };
      }

      if (existing?.status === "registered") {
        await points.earn({
          sessionId: context.sessionId,
          senderId: context.message.senderId,
          amount: existing.stake,
          source: EXPEDITION_PLUGIN_ID,
          description: "修改远征报名返还旧投入",
          operatorId: context.message.senderId,
          idempotencyKey: ledgerKey(existing, "modify-refund"),
          metadata: {
            pluginId: EXPEDITION_PLUGIN_ID,
            action: "modify_refund",
            dateKey,
          },
        });
      }

      const modified = existing?.status === "registered";
      const entry = existing
        ? await store.updateEntryPlan(existing, {
            groupName: context.groupName,
            senderName: context.message.senderName,
            plan: plan.plan,
          })
        : await store.createEntry({
            sessionId: context.sessionId,
            groupName: context.groupName,
            senderId: context.message.senderId,
            senderName: context.message.senderName,
            dateKey,
            plan: plan.plan,
          });

      await points.spend({
        sessionId: context.sessionId,
        senderId: context.message.senderId,
        amount: entry.stake,
        source: EXPEDITION_PLUGIN_ID,
        description: "远征报名投入",
        operatorId: context.message.senderId,
        idempotencyKey: ledgerKey(entry, "stake"),
        metadata: {
          pluginId: EXPEDITION_PLUGIN_ID,
          action: "stake",
          strategy: entry.strategy,
          stake: entry.stake,
          dateKey,
        },
      });

      const balanceAfter = await points.getBalance(context.sessionId, context.message.senderId);
      return {
        ok: true as const,
        unchanged: false,
        modified,
        entry,
        balanceAfter: balanceAfter.balance,
      };
    });

    if (!result.ok) {
      return result.message;
    }

    if (result.unchanged) {
      return unchangedText(result.entry, result.balanceAfter);
    }

    return result.modified
      ? modifiedText(result.entry, result.balanceAfter)
      : registeredText(result.entry, result.balanceAfter, context.content.trim() === "远征");
  }

  private async boostEntry(context: PluginContext): Promise<string> {
    const messageDate = new Date(context.message.createdAtUnixMs);
    if (!isWithinBoostWindow(messageDate)) {
      return nonBoostTimeText();
    }

    const dateKey = getBusinessDateKey(messageDate, EXPEDITION_TIMEZONE);
    const result = await this.options.db.transaction(async (tx) => {
      const store = this.options.store.withTransaction(tx);
      const points = this.options.points.withTransaction(tx);
      const entry = await store.findEntry(context.sessionId, dateKey, context.message.senderId);
      if (!entry || entry.status !== "registered") {
        return {
          ok: false as const,
          message: notRegisteredBoostText(),
        };
      }
      if (entry.boosted) {
        return {
          ok: false as const,
          message: alreadyBoostedText(),
        };
      }

      const balance = await points.getBalance(context.sessionId, context.message.senderId);
      if (balance.balance < MIN_STAKE) {
        return {
          ok: false as const,
          message: boostInsufficientText(),
        };
      }

      const expectedBoostStake = Math.max(MIN_STAKE, Math.floor(entry.stake * 0.5));
      const boostStake = Math.min(expectedBoostStake, balance.balance);
      const ledger = await points.spend({
        sessionId: context.sessionId,
        senderId: context.message.senderId,
        amount: boostStake,
        source: EXPEDITION_PLUGIN_ID,
        description: "远征临门一爪加码",
        operatorId: context.message.senderId,
        idempotencyKey: ledgerKey(entry, "boost"),
        metadata: {
          pluginId: EXPEDITION_PLUGIN_ID,
          action: "boost",
          dateKey,
          boostStake,
          stakeBeforeBoost: entry.stake,
        },
      });
      const boostedEntry = await store.boostEntry(entry, boostStake);

      return {
        ok: true as const,
        entry: boostedEntry,
        boostStake,
        balanceAfter: ledger.balanceAfter,
      };
    });

    if (!result.ok) {
      return result.message;
    }

    return boostedText(result.boostStake, result.entry.stake, result.balanceAfter);
  }

  private async castSpell(context: PluginContext, castType: ExpeditionCastType): Promise<string> {
    const messageDate = new Date(context.message.createdAtUnixMs);
    if (!isBeforeDailyCutoff(messageDate, EXPEDITION_SETTLEMENT_CUTOFF, EXPEDITION_TIMEZONE)) {
      return castClosedText();
    }

    const targetId = resolveMentionTarget(context);
    if (!targetId) {
      return castTargetMissingText(castType);
    }
    if (targetId === context.message.senderId) {
      return castSelfText();
    }

    const dateKey = getBusinessDateKey(messageDate, EXPEDITION_TIMEZONE);
    const result = await this.options.db.transaction(async (tx) => {
      const store = this.options.store.withTransaction(tx);
      const targetEntry = await store.findEntry(context.sessionId, dateKey, targetId);
      if (!targetEntry || targetEntry.status !== "registered") {
        return {
          ok: false as const,
          message: castTargetNotRegisteredText(),
        };
      }

      const existing = await store.findCast({
        sessionId: context.sessionId,
        dateKey,
        casterId: context.message.senderId,
        targetId,
      });

      if (!existing) {
        const count = await store.countCasterCasts({
          sessionId: context.sessionId,
          dateKey,
          casterId: context.message.senderId,
        });
        if (count >= MAX_CASTS_PER_DAY) {
          return {
            ok: false as const,
            message: castLimitText(),
          };
        }

        const cast = await store.createCast({
          sessionId: context.sessionId,
          groupName: context.groupName,
          dateKey,
          casterId: context.message.senderId,
          casterName: context.message.senderName,
          targetId,
          targetName: targetEntry.senderName,
          castType,
        });

        return {
          ok: true as const,
          created: true,
          cast,
          remainingCasts: MAX_CASTS_PER_DAY - count - 1,
        };
      }

      const cast = await store.updateCast(existing, {
        groupName: context.groupName,
        casterName: context.message.senderName,
        targetName: targetEntry.senderName,
        castType,
      });
      const count = await store.countCasterCasts({
        sessionId: context.sessionId,
        dateKey,
        casterId: context.message.senderId,
      });

      return {
        ok: true as const,
        created: false,
        cast,
        remainingCasts: MAX_CASTS_PER_DAY - count,
      };
    });

    if (!result.ok) {
      return result.message;
    }

    return result.created
      ? castSuccessText(result.cast, result.remainingCasts)
      : castModifiedText(result.cast);
  }

  private async getMyCasts(context: PluginContext): Promise<string> {
    const dateKey = getBusinessDateKey(new Date(context.message.createdAtUnixMs), EXPEDITION_TIMEZONE);
    const casts = await this.options.store.listCastsByCaster({
      sessionId: context.sessionId,
      dateKey,
      casterId: context.message.senderId,
    });

    if (casts.length === 0) {
      return myCastsEmptyText();
    }

    return myCastsText(casts);
  }

  private async cancelEntry(context: PluginContext): Promise<string> {
    const messageDate = new Date(context.message.createdAtUnixMs);
    if (!isBeforeDailyCutoff(messageDate, EXPEDITION_SETTLEMENT_CUTOFF, EXPEDITION_TIMEZONE)) {
      return "今日远征已经锁定，无法取消。\n\n咪露把登记簿抱紧：\n“名单已经锁柜子里了喵，钥匙咪露吞掉了。”";
    }

    const dateKey = getBusinessDateKey(messageDate, EXPEDITION_TIMEZONE);
    const result = await this.options.db.transaction(async (tx) => {
      const store = this.options.store.withTransaction(tx);
      const points = this.options.points.withTransaction(tx);
      const entry = await store.findEntry(context.sessionId, dateKey, context.message.senderId);
      if (!entry || entry.status !== "registered") {
        return {
          cancelled: false as const,
        };
      }
      if (entry.boosted) {
        return {
          cancelled: false as const,
          locked: true,
        };
      }

      await points.earn({
        sessionId: context.sessionId,
        senderId: context.message.senderId,
        amount: entry.stake,
        source: EXPEDITION_PLUGIN_ID,
        description: "取消远征返还投入",
        operatorId: context.message.senderId,
        idempotencyKey: ledgerKey(entry, "cancel-refund"),
        metadata: {
          pluginId: EXPEDITION_PLUGIN_ID,
          action: "cancel_refund",
          dateKey,
        },
      });
      await store.cancelEntry(entry);
      const balance = await points.getBalance(context.sessionId, context.message.senderId);
      return {
        cancelled: true as const,
        balance: balance.balance,
      };
    });

    if ("locked" in result && result.locked) {
      return lockedCancelText();
    }

    if (!result.cancelled) {
      return notRegisteredCancelText();
    }

    return cancelledText(result.balance);
  }

  private async getMyReport(context: PluginContext): Promise<string> {
    const dateKey = getBusinessDateKey(new Date(), EXPEDITION_TIMEZONE);
    if (await this.isSettlementRunning(context.sessionId, dateKey)) {
      return settlementRunningText();
    }

    const report = await this.options.store.getReport(context.sessionId, dateKey, context.message.senderId);
    if (report) {
      return reportText(report);
    }

    const entry = await this.options.store.findEntry(context.sessionId, dateKey, context.message.senderId);
    if (entry?.status === "registered") {
      return reportPendingText();
    }

    return noReportText();
  }

  private async getMyRelics(context: PluginContext): Promise<string> {
    const relics = await this.options.store.listRecentActiveRelics(
      context.sessionId,
      context.message.senderId,
      10,
    );
    if (relics.length === 0) {
      return noRelicText();
    }

    const allRelics = await this.options.store.listActiveRelics(
      context.sessionId,
      context.message.senderId,
    );
    const bonuses = collectRelicBonuses(allRelics);
    const lines = [
      `当前遗物：${allRelics.length} 件`,
      `生还率加成：+${formatPercentBp(bonuses.survivalBonusBp)}`,
      `积分倍率加成：+${formatMultiplierBp(bonuses.multiplierBonusBp)}`,
      `推进层数加成：+${bonuses.diveBonus}`,
      `掉落率加成：+${formatPercentBp(bonuses.dropRateBonusBp)}，品质点 +${bonuses.qualityBonus}`,
      `净化加成：+${formatPercentBp(bonuses.purificationBonusBp)}`,
      "",
      "最近遗物：",
      ...relics.map((relic, index) => (
        `${index + 1}. ${RARITY_LABELS[relic.rarity]}遗物「${relic.name}」：${relic.description}`
      )),
    ];

    return lines.join("\n");
  }

  private async getRanking(context: PluginContext): Promise<string> {
    const dateKey = getBusinessDateKey(new Date(), EXPEDITION_TIMEZONE);
    if (await this.isSettlementRunning(context.sessionId, dateKey)) {
      return settlementRunningText();
    }

    const ranking = await this.options.store.listRanking(context.sessionId, 10);
    if (ranking.length === 0) {
      return emptyRankingText();
    }

    return [
      "当前最高层数榜：",
      ...ranking.map((row, index) => `${index + 1}. ${row.senderName} 第 ${row.currentDepth} 层`),
    ].join("\n");
  }

  private async isSettlementRunning(sessionId: string, dateKey: string): Promise<boolean> {
    const operation = await this.options.operationRuns.get({
      pluginId: EXPEDITION_PLUGIN_ID,
      scope: "session",
      scopeId: sessionId,
      operationKey: settlementOperationKey(dateKey),
    });

    return operation?.status === "running";
  }

  private async runSessionSettlement(
    sessionId: string,
    groupName: string | undefined,
    dateKey: string,
  ): Promise<void> {
    const operation = await this.options.operationRuns.tryStart({
      pluginId: EXPEDITION_PLUGIN_ID,
      scope: "session",
      scopeId: sessionId,
      operationKey: settlementOperationKey(dateKey),
      retryFailed: true,
      metadata: {
        dateKey,
      },
    });

    if (!operation.started) {
      return;
    }

    try {
      const summary = await this.options.db.transaction(async (tx) => {
        const store = this.options.store.withTransaction(tx);
        const points = this.options.points.withTransaction(tx);
        return this.settleSessionInTransaction(store, points, sessionId, groupName, dateKey);
      });

      await this.options.operationRuns.markSucceeded(operation.run.id, {
        dateKey,
        participantCount: summary.participantCount,
      });

      await this.options.sendMessage({
        sessionId,
        groupName: summary.groupName,
        text: summary.announcementText,
      });
    } catch (error) {
      await this.options.operationRuns.markFailed(operation.run.id, error, { dateKey });
      throw error;
    }
  }

  private async settleSessionInTransaction(
    store: ExpeditionStore,
    points: PointsService,
    sessionId: string,
    groupName: string | undefined,
    dateKey: string,
  ): Promise<ExpeditionSettlementSummary> {
    const entries = await store.listRegisteredEntries(sessionId, dateKey);
    const world = await store.getOrCreateWorld(sessionId, groupName, sample(BOSS_NAMES));
    const randomEvents = await store.listRandomEvents(sessionId, dateKey);
    const results: SettlementResult[] = [];
    let totalPurification = 0;

    for (const entry of entries) {
      const player = await store.getOrCreatePlayer({
        sessionId: entry.sessionId,
        senderId: entry.senderId,
        senderName: entry.senderName,
      });
      const relics = await store.listActiveRelics(entry.sessionId, entry.senderId);
      const casts = await store.listCastsForTarget({
        sessionId: entry.sessionId,
        dateKey: entry.dateKey,
        targetId: entry.senderId,
      });
      const result = await this.settleEntry(
        store,
        points,
        entry,
        player,
        relics,
        casts,
        randomEvents.filter((event) => (
          event.targetSenderId === entry.senderId &&
          event.targetEntryId === entry.id &&
          event.targetEntryRevision === entry.revision
        )),
        world.bossName,
      );
      results.push(result);
      totalPurification += result.report.purification;
    }

    const remainingPollution = Math.max(0, world.bossPollution - totalPurification);
    const bossDefeated = remainingPollution === 0;
    const nextBossMaxPollution = bossDefeated ? world.bossMaxPollution * 2 : world.bossMaxPollution;
    const nextBossName = bossDefeated ? sampleDifferent(BOSS_NAMES, world.bossName) : world.bossName;
    const updatedWorld = await store.updateWorldAfterSettlement({
      sessionId,
      groupName,
      bossName: nextBossName,
      bossMaxPollution: nextBossMaxPollution,
      bossPollution: bossDefeated ? nextBossMaxPollution : remainingPollution,
    });

    const reports = results.map((result) => result.report);
    const announcementText = buildAnnouncement({
      reports,
      relics: results.flatMap((result) => result.relic ? [result.relic] : []),
      dateKey,
      bossName: world.bossName,
      bossPollution: remainingPollution,
      bossMaxPollution: world.bossMaxPollution,
      bossDefeated,
      nextBossName: updatedWorld.bossName,
      totalPurification,
    });

    return {
      sessionId,
      groupName,
      dateKey,
      participantCount: reports.length,
      survivedCount: reports.filter((report) => report.outcome === "survived").length,
      deadCount: reports.filter((report) => report.outcome === "dead").length,
      totalPurification,
      bossName: updatedWorld.bossName,
      bossPollution: updatedWorld.bossPollution,
      bossMaxPollution: updatedWorld.bossMaxPollution,
      bossDefeated,
      announcementText,
    };
  }

  private async settleEntry(
    store: ExpeditionStore,
    points: PointsService,
    entry: ExpeditionEntryRecord,
    player: ExpeditionPlayerRecord,
    relics: ExpeditionRelicRecord[],
    casts: ExpeditionCastRecord[],
    randomEvents: ExpeditionRandomEventRecord[],
    bossName: string,
  ): Promise<SettlementResult> {
    const castModifiers = buildCastModifiers(casts);
    const randomEventModifiers = buildRandomEventModifiers(randomEvents);
    const resolution = resolveExpeditionSettlement({
      entry,
      player,
      relics,
      extraModifiers: [
        ...castModifiers,
        ...randomEventModifiers,
      ],
      bossName,
      random: {
        randomIntInclusive,
        rollBasisPoints,
      },
      renderSpecialEvent: (input) => renderTemplate(sample(SPECIAL_EVENT_TEMPLATES), input),
    });
    let relic: ExpeditionRelicRecord | undefined;

    if (resolution.survived) {
      await points.earn({
        sessionId: entry.sessionId,
        senderId: entry.senderId,
        amount: resolution.rewardPoints,
        source: EXPEDITION_PLUGIN_ID,
        description: "远征生还奖励",
        operatorId: "system",
        idempotencyKey: ledgerKey(entry, "reward"),
        metadata: {
          pluginId: EXPEDITION_PLUGIN_ID,
          action: "reward",
          dateKey: entry.dateKey,
          strategy: entry.strategy,
        },
      });

      if (resolution.relicDropped) {
        relic = await store.insertRelic(createRelic(
          entry,
          resolution.targetDepth,
          resolution.qualityBonus,
        ));
      }
    } else {
      await store.deactivateActiveRelics(entry.sessionId, entry.senderId);
    }

    await store.updatePlayerAfterSettlement({
      sessionId: entry.sessionId,
      senderId: entry.senderId,
      senderName: entry.senderName,
      survived: resolution.survived,
      finalDepth: resolution.finalDepth,
      purification: resolution.purification,
    });
    await store.markEntrySettled(entry.id);

    const report: ExpeditionReportRecord = {
      id: 0,
      sessionId: entry.sessionId,
      groupName: entry.groupName,
      dateKey: entry.dateKey,
      senderId: entry.senderId,
      senderName: entry.senderName,
      strategy: entry.strategy,
      stake: entry.stake,
      outcome: resolution.survived ? "survived" : "dead",
      startDepth: player.currentDepth,
      targetDepth: resolution.targetDepth,
      finalDepth: resolution.finalDepth,
      survivalRateBasisPoints: resolution.survivalRateBp,
      multiplierBasisPoints: resolution.multiplierBp,
      boosted: entry.boosted,
      boostStake: entry.boostStake,
      rewardPoints: resolution.rewardPoints,
      lostPoints: resolution.survived ? 0 : entry.stake,
      purification: resolution.purification,
      deathReason: resolution.survived
        ? undefined
        : chooseDeathReason(entry, relics, resolution.targetDepth),
      relicName: relic?.name,
      relicRarity: relic?.rarity,
      specialEventText: resolution.specialEvent?.text,
      details: {
        advance: resolution.advance,
        relicCountBeforeSettlement: relics.length,
        blessingCount: casts.filter((cast) => cast.castType === "blessing").length,
        blessingSurvivalBpDelta: resolution.modifierSummary.bySource.blessing.survivalBpDelta,
        jinxCount: casts.filter((cast) => cast.castType === "jinx").length,
        jinxSurvivalBpDelta: resolution.modifierSummary.bySource.jinx.survivalBpDelta,
        socialSurvivalBpDelta:
          resolution.modifierSummary.bySource.blessing.survivalBpDelta +
          resolution.modifierSummary.bySource.jinx.survivalBpDelta,
        randomEventCount: randomEvents.length,
        randomEventTitles: uniqueStrings(randomEvents.map((event) => event.title)),
        modifierCount: resolution.modifierSummary.modifiers.length,
        modifierTotals: modifierTotalsToDetails(resolution.modifierSummary.totals),
        modifierSources: modifierSourcesToDetails(resolution.modifierSummary.bySource),
        boostSurvivalPenaltyBp: resolution.boostSurvivalPenaltyBp,
        boostMultiplierBonusBp: resolution.boostMultiplierBonusBp,
      },
      createdAt: new Date(),
    };
    await store.insertReport(report);

    return {
      report,
      relic,
    };
  }
}

function parseEntryCommand(content: string): { strategy: ExpeditionStrategy; amount?: number; allIn: boolean } | null {
  const parts = content.trim().split(/\s+/);
  if (parts[0] !== "远征") {
    return null;
  }

  if (parts.length === 1) {
    return {
      strategy: "adventure",
      amount: MIN_STAKE,
      allIn: false,
    };
  }

  if (parts.length === 2 && parts[1] === "梭哈") {
    return {
      strategy: "adventure",
      allIn: true,
    };
  }

  const strategy = parseStrategy(parts[1]);
  if (!strategy || parts.length !== 3) {
    return null;
  }

  if (parts[2] === "梭哈") {
    return {
      strategy,
      allIn: true,
    };
  }

  const amount = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isInteger(amount) || String(amount) !== parts[2] || amount <= 0) {
    return null;
  }

  return {
    strategy,
    amount,
    allIn: false,
  };
}

function parseStrategy(value: string | undefined): ExpeditionStrategy | null {
  if (value === "稳健") return "steady";
  if (value === "冒险") return "adventure";
  if (value === "疯狂") return "crazy";
  return null;
}

function resolveStake(
  command: { strategy: ExpeditionStrategy; amount?: number; allIn: boolean },
  effectiveBalance: number,
): { ok: true; plan: ExpeditionEntryPlan } | { ok: false; message: string } {
  const maxStake = Math.floor(effectiveBalance * MAX_STAKE_RATE);
  const stake = command.allIn ? maxStake : command.amount ?? MIN_STAKE;
  if (effectiveBalance < MIN_STAKE) {
    return {
      ok: false,
      message: insufficientPointsText(),
    };
  }

  if (stake < MIN_STAKE) {
    return {
      ok: false,
      message: stakeTooLowText(),
    };
  }

  if (stake > maxStake) {
    return {
      ok: false,
      message: stakeTooHighText(),
    };
  }

  return {
    ok: true,
    plan: {
      strategy: command.strategy,
      stake,
      allIn: command.allIn,
    },
  };
}

function samePlan(entry: ExpeditionEntryRecord, plan: ExpeditionEntryPlan): boolean {
  return entry.strategy === plan.strategy && entry.stake === plan.stake && entry.allIn === plan.allIn;
}

function buildCastModifiers(casts: ExpeditionCastRecord[]): ExpeditionModifier[] {
  return casts.map((cast) => {
    const value = randomIntInclusive(50, 200);
    return {
      source: cast.castType === "blessing" ? "blessing" : "jinx",
      sourceId: String(cast.id),
      label: `${cast.casterName}的${castTypeLabel(cast.castType)}`,
      survivalBpDelta: cast.castType === "blessing" ? value : -value,
    };
  });
}

function buildRandomEventModifiers(events: ExpeditionRandomEventRecord[]): ExpeditionModifier[] {
  if (events.length === 0) {
    return [];
  }

  const raw = events.reduce<Required<Omit<ExpeditionRandomEventEffectValue, "rewardPoints">>>(
    (acc, event) => ({
      advanceDelta: acc.advanceDelta + (event.effectValue.advanceDelta ?? 0),
      survivalBpDelta: acc.survivalBpDelta + (event.effectValue.survivalBpDelta ?? 0),
      multiplierBpDelta: acc.multiplierBpDelta + (event.effectValue.multiplierBpDelta ?? 0),
      dropRateBpDelta: acc.dropRateBpDelta + (event.effectValue.dropRateBpDelta ?? 0),
      qualityDelta: acc.qualityDelta + (event.effectValue.qualityDelta ?? 0),
      purificationBpDelta: acc.purificationBpDelta + (event.effectValue.purificationBpDelta ?? 0),
    }),
    {
      advanceDelta: 0,
      survivalBpDelta: 0,
      multiplierBpDelta: 0,
      dropRateBpDelta: 0,
      qualityDelta: 0,
      purificationBpDelta: 0,
    },
  );

  return [{
    source: "random_event",
    label: uniqueStrings(events.map((event) => event.title)).join("、") || "随机事件",
    advanceDelta: clamp(raw.advanceDelta, -1, 2),
    survivalBpDelta: clamp(raw.survivalBpDelta, -500, 500),
    multiplierBpDelta: clamp(raw.multiplierBpDelta, -1000, 3000),
    dropRateBpDelta: clamp(raw.dropRateBpDelta, -500, 1000),
    qualityDelta: clamp(raw.qualityDelta, 0, 20),
    purificationBpDelta: clamp(raw.purificationBpDelta, 0, 1000),
  }];
}

function createRelic(
  entry: ExpeditionEntryRecord,
  targetDepth: number,
  qualityBonus: number,
): {
  sessionId: string;
  senderId: string;
  name: string;
  rarity: ExpeditionRelicRarity;
  effectType: ExpeditionRelicEffectType;
  effectValue: ExpeditionRelicEffectValue;
  description: string;
  acquiredDateKey: string;
} {
  const effectType = sample<ExpeditionRelicEffectType>([
    "survival",
    "greed",
    "dive",
    "luck",
    "purification",
    "curse",
  ]);
  const qualityScore = randomIntInclusive(1, 1000)
    + STRATEGY_CONFIG[entry.strategy].qualityModifier
    + Math.floor(targetDepth / 5)
    + qualityBonus;
  const rarity = qualityScore >= 1040
    ? "legendary"
    : qualityScore >= 941
      ? "epic"
      : qualityScore >= 781
        ? "rare"
        : "common";
  const name = sample(RELIC_NAMES[effectType]);
  const effectValue = RELIC_EFFECT_VALUES[rarity][effectType];

  return {
    sessionId: entry.sessionId,
    senderId: entry.senderId,
    name,
    rarity,
    effectType,
    effectValue,
    description: describeRelicEffect(effectType, effectValue),
    acquiredDateKey: entry.dateKey,
  };
}

function describeRelicEffect(
  effectType: ExpeditionRelicEffectType,
  value: ExpeditionRelicEffectValue,
): string {
  if (effectType === "survival") return `生还率 +${formatPercentBp(value.survivalBonusBp ?? 0)}`;
  if (effectType === "greed") return `积分倍率 +${formatMultiplierBp(value.multiplierBonusBp ?? 0)}`;
  if (effectType === "dive") return `推进层数 +${value.diveBonus ?? 0}`;
  if (effectType === "luck") {
    return `掉落率 +${formatPercentBp(value.dropRateBonusBp ?? 0)}，品质点 +${value.qualityBonus ?? 0}`;
  }
  if (effectType === "purification") return `净化 +${formatPercentBp(value.purificationBonusBp ?? 0)}`;
  return `积分倍率 +${formatMultiplierBp(value.multiplierBonusBp ?? 0)}，生还率 -${formatPercentBp(value.curseSurvivalPenaltyBp ?? 0)}`;
}

function chooseDeathReason(
  entry: ExpeditionEntryRecord,
  relics: ExpeditionRelicRecord[],
  targetDepth: number,
): string {
  const hasGreedyRelic = relics.some((relic) => (
    relic.effectType === "greed" || relic.effectType === "curse"
  ));
  let pool = [...DEATH_REASONS];

  if (entry.stake >= 100 || hasGreedyRelic) {
    pool = [...GREEDY_DEATH_REASONS, ...pool];
  }

  if (entry.allIn || entry.strategy === "crazy") {
    pool = [...CRAZY_DEATH_REASONS, ...pool];
  }

  return renderTemplate(sample(pool), {
    player: entry.senderName,
    depth: targetDepth,
    points: entry.stake,
    strategy: STRATEGY_LABELS[entry.strategy],
  });
}

function buildAnnouncement(input: {
  reports: ExpeditionReportRecord[];
  relics: ExpeditionRelicRecord[];
  dateKey: string;
  bossName: string;
  bossPollution: number;
  bossMaxPollution: number;
  bossDefeated: boolean;
  nextBossName: string;
  totalPurification: number;
}): string {
  const survived = input.reports.filter((report) => report.outcome === "survived");
  const dead = input.reports.filter((report) => report.outcome === "dead");
  const boostedReports = input.reports.filter((report) => report.boosted);
  const richest = maxBy(survived, (report) => (
    report.rewardPoints - report.stake + (report.boosted ? 1_000_000 : 0)
  ));
  const poorest = maxBy(dead, (report) => report.lostPoints + (report.boosted ? 1_000_000 : 0));
  const deepest = maxBy(input.reports, (report) => report.targetDepth);
  const boostMoment = maxBy(boostedReports, (report) => (
    report.outcome === "survived" ? report.rewardPoints - report.stake : report.lostPoints
  ));
  const jinxDead = maxBy(
    input.reports.filter((report) => getReportDetailNumber(report, "jinxCount") > 0 && report.outcome === "dead"),
    (report) => getReportDetailNumber(report, "jinxCount") * 100_000
      + Math.abs(getReportDetailNumber(report, "jinxSurvivalBpDelta")) * 100
      + report.lostPoints,
  );
  const jinxSurvivor = maxBy(
    input.reports.filter((report) => getReportDetailNumber(report, "jinxCount") > 0 && report.outcome === "survived"),
    (report) => getReportDetailNumber(report, "jinxCount") * 100_000
      + Math.abs(getReportDetailNumber(report, "jinxSurvivalBpDelta")) * 100
      + report.rewardPoints - report.stake,
  );
  const socialFocus = maxBy(
    input.reports.filter((report) => (
      getReportDetailNumber(report, "blessingCount") + getReportDetailNumber(report, "jinxCount")
    ) > 0),
    (report) => {
      const blessingCount = getReportDetailNumber(report, "blessingCount");
      const jinxCount = getReportDetailNumber(report, "jinxCount");
      return (blessingCount + jinxCount) * 100_000
        + Math.abs(getReportDetailNumber(report, "socialSurvivalBpDelta")) * 100
        + randomIntInclusive(1, 99);
    },
  );
  const bestRelic = maxBy(input.relics, (relic) => rarityRank(relic.rarity));
  const specialEvents = input.reports.map((report) => report.specialEventText).filter(Boolean);
  const lines = [
    `${sample(ANNOUNCEMENT_TITLES)}：`,
    `${input.reports.length} 人出发，${survived.length} 人生还，${dead.length} 人阵亡。`,
  ];

  if (richest) {
    lines.push(
      "",
      `今日暴富：${richest.senderName} ${STRATEGY_LABELS[richest.strategy]}远征投入 ${richest.stake}，倍率 x${formatMultiplierBp(richest.multiplierBasisPoints)}，带回 ${richest.rewardPoints} 积分。`,
    );
  }

  if (poorest) {
    lines.push("", `今日血亏：${poorest.senderName} 损失 ${poorest.lostPoints} 积分，${poorest.deathReason}`);
  }

  if (deepest) {
    lines.push("", `最高深入：${deepest.senderName} 第 ${deepest.targetDepth} 层。`);
  }

  if (boostMoment) {
    const resultText = boostMoment.outcome === "survived"
      ? `生还带回 ${boostMoment.rewardPoints} 积分`
      : `阵亡损失 ${boostMoment.lostPoints} 积分`;
    lines.push(
      "",
      `临门一爪：${boostMoment.senderName} 追加 ${boostMoment.boostStake} 积分后${resultText}。`,
    );
  }

  if (jinxDead) {
    lines.push(
      "",
      `今日毒奶现场：${jinxDead.senderName} 收到 ${getReportDetailNumber(jinxDead, "jinxCount")} 份毒奶后，在第 ${jinxDead.targetDepth} 层阵亡。`,
      "咪露评价：大家的嘴真的很准喵。",
    );
  }

  if (jinxSurvivor) {
    lines.push(
      "",
      `毒奶反杀：${jinxSurvivor.senderName} 收到 ${getReportDetailNumber(jinxSurvivor, "jinxCount")} 份毒奶，结果${STRATEGY_LABELS[jinxSurvivor.strategy]}远征生还，带回 ${jinxSurvivor.rewardPoints} 积分。`,
      "咪露评价：嘴硬赢了命运一次喵。",
    );
  }

  if (socialFocus) {
    lines.push(
      "",
      `今日公会焦点：${socialFocus.senderName} 出发前收到 ${getReportDetailNumber(socialFocus, "blessingCount") + getReportDetailNumber(socialFocus, "jinxCount")} 次围观施法。`,
      `祝福 ${getReportDetailNumber(socialFocus, "blessingCount")}，毒奶 ${getReportDetailNumber(socialFocus, "jinxCount")}。`,
      "咪露评价：这已经不是远征，这是公开处刑预约喵。",
    );
  }

  if (bestRelic) {
    lines.push("", `最佳遗物：${RARITY_LABELS[bestRelic.rarity]}遗物「${bestRelic.name}」。`);
  }

  if (specialEvents[0]) {
    lines.push("", specialEvents[0]);
  }

  lines.push(
    "",
    `今日裂隙净化：${input.totalPurification}`,
    `世界 Boss「${input.bossName}」剩余污染：${input.bossPollution} / ${input.bossMaxPollution}`,
  );

  if (input.bossDefeated) {
    lines.push(
      "",
      bossDefeatedText(input.bossName, input.nextBossName),
    );
  }

  return lines.join("\n");
}

function reportText(report: ExpeditionReportRecord): string {
  if (report.outcome === "survived") {
    return [
      `今日远征：${STRATEGY_LABELS[report.strategy]}`,
      `投入积分：${report.stake}`,
      report.boosted ? `临门一爪：已加码 ${report.boostStake}` : undefined,
      "结果：生还",
      `推进层数：${report.startDepth} -> ${report.finalDepth}`,
      `生还率：${formatPercentBp(report.survivalRateBasisPoints)}`,
      `收益倍率：x${formatMultiplierBp(report.multiplierBasisPoints)}`,
      `获得积分：${report.rewardPoints}`,
      report.relicName ? `获得遗物：${RARITY_LABELS[report.relicRarity ?? "common"]}遗物「${report.relicName}」` : undefined,
      socialModifierText(report),
      randomEventReportText(report),
      `裂隙净化：${report.purification}`,
      report.specialEventText,
    ].filter(Boolean).join("\n");
  }

  return [
    `今日远征：${STRATEGY_LABELS[report.strategy]}`,
    `投入积分：${report.stake}`,
    report.boosted ? `临门一爪：已加码 ${report.boostStake}` : undefined,
    "结果：阵亡",
    `阵亡层数：${report.targetDepth}`,
    `生还率：${formatPercentBp(report.survivalRateBasisPoints)}`,
    `损失积分：${report.lostPoints}`,
    "本轮遗物：已清空",
    `死因：${report.deathReason}`,
    socialModifierText(report),
    randomEventReportText(report),
    `裂隙净化：${report.purification}`,
    report.specialEventText,
  ].filter(Boolean).join("\n");
}

function socialModifierText(report: ExpeditionReportRecord): string | undefined {
  const blessingCount = getReportDetailNumber(report, "blessingCount");
  const jinxCount = getReportDetailNumber(report, "jinxCount");
  if (blessingCount === 0 && jinxCount === 0) {
    return undefined;
  }

  const blessingDelta = getReportDetailNumber(report, "blessingSurvivalBpDelta");
  const jinxDelta = getReportDetailNumber(report, "jinxSurvivalBpDelta");
  const socialDelta = getReportDetailNumber(report, "socialSurvivalBpDelta");
  return [
    `群友祝福：${blessingCount} 次，合计 ${formatSignedPercentBp(blessingDelta)} 生还率`,
    `群友毒奶：${jinxCount} 次，合计 ${formatSignedPercentBp(jinxDelta)} 生还率`,
    `社交净修正：${formatSignedPercentBp(socialDelta)}`,
  ].join("\n");
}

function randomEventReportText(report: ExpeditionReportRecord): string | undefined {
  const count = getReportDetailNumber(report, "randomEventCount");
  if (count === 0) {
    return undefined;
  }

  const titles = getReportDetailStringArray(report, "randomEventTitles");
  return `随机事件：${titles.length > 0 ? titles.join("、") : `${count} 次临时修正`}`;
}

function registeredText(entry: ExpeditionEntryRecord, balanceAfter: number, defaultCommand: boolean): string {
  const values = {
    strategy: STRATEGY_LABELS[entry.strategy],
    stake: entry.stake,
    balance: balanceAfter,
    settleTime: EXPEDITION_SETTLEMENT_CUTOFF,
  };
  if (defaultCommand) {
    return appendCommandMenuHint(renderTemplate(sample([
      "报名成功。\n\n今日远征：冒险\n投入积分：10\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露把一张默认申请表塞进任务板：\n“先按冒险 10 积分给你登记啦。下次想更刺激，可以试试「远征 疯狂 100」或者「远征 疯狂 梭哈」喵。”",
      "报名成功。\n\n今日远征：冒险\n投入积分：10\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露替你勾了默认选项：\n“先来一份冒险 10 积分套餐喵。想把心跳拉满，下次可以试试「远征 疯狂 梭哈」。”",
      "报名成功。\n\n今日远征：冒险\n投入积分：10\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露把最薄的一张申请表推过来：\n“新手上路就先这样喵。等胆子长大了，再写「远征 疯狂 100」。”",
    ]), values));
  }

  return appendCommandMenuHint(renderTemplate(sample([
    "报名成功。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n前台猫娘咪露把你的名字贴上任务板，尾巴轻轻一晃：\n“好耶，又有勇者主动交押金了喵。”",
    "报名成功。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露把申请表夹进任务板：\n“押金收到喵。接下来请保持乐观，至少保持到结算前。”",
    "报名成功。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露晃了晃笔尖：\n“名字写上去了喵。现在后悔还来得及，但那样就不够好看了。”",
    "报名成功。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露笑眯眯地盖章：\n“又一位自愿走进裂隙的好心人，公会会记住你的押金喵。”",
  ]), values));
}

function modifiedText(entry: ExpeditionEntryRecord, balanceAfter: number): string {
  return renderTemplate(sample([
    "远征计划已修改。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露盯着申请表，眼睛亮了起来：\n“改计划？哇，今天的事故报告有素材了喵。”",
    "远征计划已修改。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露把旧申请表揉成团：\n“改好了喵。命运刚刚也跟着改了一下笑容。”",
    "远征计划已修改。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露重新盖章：\n“确认换这版喵？好，咪露最喜欢看人临时变勇敢。”",
    "远征计划已修改。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露低头核对金额：\n“策略改了，押金也改了。希望你的运气也跟着改好一点喵。”",
  ]), {
    strategy: STRATEGY_LABELS[entry.strategy],
    stake: entry.stake,
    balance: balanceAfter,
    settleTime: EXPEDITION_SETTLEMENT_CUTOFF,
  });
}

function unchangedText(entry: ExpeditionEntryRecord, balanceAfter: number): string {
  return renderTemplate(sample([
    "你的远征计划没有变化。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露用爪子点了点任务板：\n“同一张申请表不用交两遍喵，我还没这么健忘。”",
    "你的远征计划没有变化。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露把申请表转回来：\n“一模一样喵。你是在确认自己真的这么勇吗？”",
    "你的远征计划没有变化。\n\n今日远征：{strategy}\n投入积分：{stake}\n剩余积分：{balance}\n结算时间：{settleTime}\n\n咪露戳了戳登记簿：\n“已经登记过啦。重复念咒不会让生还率偷偷上涨喵。”",
  ]), {
    strategy: STRATEGY_LABELS[entry.strategy],
    stake: entry.stake,
    balance: balanceAfter,
    settleTime: EXPEDITION_SETTLEMENT_CUTOFF,
  });
}

function boostedText(boostStake: number, totalStake: number, balanceAfter: number): string {
  return renderTemplate(sample([
    "加码成功。\n\n追加投入：{extraStake}\n当前总投入：{totalStake}\n剩余积分：{balance}\n最终倍率 +0.5\n生还率 -10%\n\n咪露把爪印盖在申请表上：\n“好耶，理智又少了一点喵。”",
    "加码成功。\n\n追加投入：{extraStake}\n当前总投入：{totalStake}\n剩余积分：{balance}\n最终倍率 +0.5\n生还率 -10%\n\n咪露把爪印盖得特别响：\n“漂亮喵，理智刚刚从窗户跳出去了。”",
    "加码成功。\n\n追加投入：{extraStake}\n当前总投入：{totalStake}\n剩余积分：{balance}\n最终倍率 +0.5\n生还率 -10%\n\n咪露眯起眼睛：\n“这一下很有勇者味喵，也很有事故味。”",
    "加码成功。\n\n追加投入：{extraStake}\n当前总投入：{totalStake}\n剩余积分：{balance}\n最终倍率 +0.5\n生还率 -10%\n\n咪露把登记簿推回去：\n“签好了喵。现在你和裂隙之间，多了一点金钱纠纷。”",
    "加码成功。\n\n追加投入：{extraStake}\n当前总投入：{totalStake}\n剩余积分：{balance}\n最终倍率 +0.5\n生还率 -10%\n\n咪露尾巴晃得很快：\n“好耶，临门一爪成功。接下来就看命运咬哪边了喵。”",
  ]), {
    extraStake: boostStake,
    totalStake,
    balance: balanceAfter,
  });
}

function boostInsufficientText(): string {
  return sample([
    "加码失败，剩余积分不足。\n\n至少需要 10 积分才能加码。\n咪露看了看你的钱包：\n“想法很大，余额很小喵。”",
    "加码失败，剩余积分不足。\n\n至少需要 10 积分才能加码。\n咪露轻轻合上账本：\n“不是咪露小气喵，是你的钱包先认输了。”",
    "加码失败，剩余积分不足。\n\n至少需要 10 积分才能加码。\n咪露看着余额沉默了一下：\n“这点积分就别硬装大户了喵，怪心疼的。”",
  ]);
}

function alreadyBoostedText(): string {
  return sample([
    "今天已经加码过了。\n\n咪露把爪子收回去：\n“一天只能上头一次喵，公会也怕你太努力。”",
    "今天已经加码过了。\n\n咪露把爪印章举远：\n“再盖就不是加码了喵，是把申请表剁碎。”",
    "今天已经加码过了。\n\n咪露按住你的手：\n“一次就够刺激了喵。再来一次，公会要给你开专门病房。”",
  ]);
}

function notRegisteredBoostText(): string {
  return sample([
    "你还没有报名远征，不能加码。\n\n咪露晃了晃空白申请表：\n“连车都没上，就想把油门踩到底喵？”",
    "你还没有报名远征，不能加码。\n\n咪露歪头：\n“你连坑都没进，就开始嫌坑不够深喵？”",
    "你还没有报名远征，不能加码。\n\n咪露晃了晃空白名单：\n“先发送「远征」上车喵。站在站台上踩油门没有用。”",
  ]);
}

function nonBoostTimeText(): string {
  return sample([
    `现在还不能加码。\n\n临门一爪开放时间：${BOOST_WINDOW_START} - 17:49\n咪露舔了舔爪子：\n“别急喵，真正上头的时间还没到。”`,
    `现在还不能加码。\n\n临门一爪开放时间：${BOOST_WINDOW_START} - 17:49\n咪露把小铃铛扣住：\n“铃还没响喵。别急，等会儿有的是机会上头。”`,
    `现在还不能加码。\n\n临门一爪开放时间：${BOOST_WINDOW_START} - 17:49\n咪露舔了舔爪印章：\n“真正危险的柜台服务还没开始喵。”`,
  ]);
}

function lockedModifyText(): string {
  return sample([
    "今日远征已经锁定，无法修改。\n\n咪露看了看申请表上的爪印：\n“爪印都盖好了喵，现在改会把纸撕破。”",
    "今日远征已经锁定，无法修改。\n\n咪露把加码申请表压在爪子下面：\n“爪印都盖上去了喵，现在反悔会显得你很清醒。”",
    "今日远征已经锁定，无法修改。\n\n咪露把申请表塞进铁盒：\n“锁都咔哒一声了喵，现在只能祈祷，不支持改命。”",
    "今日远征已经锁定，无法修改。\n\n咪露竖起一根爪子：\n“刚才让你想清楚，现在轮到命运想清楚你了喵。”",
  ]);
}

function lockedCancelText(): string {
  return sample([
    "今日远征已经锁定，无法取消。\n\n咪露把登记簿抱紧：\n“名单已经锁柜子里了喵，钥匙咪露吞掉了。”",
    "今日远征已经锁定，无法取消。\n\n咪露把登记簿抱紧：\n“都临门一爪了喵，现在逃跑就没有节目效果了。”",
    "今日远征已经锁定，无法取消。\n\n咪露把取消章藏进抽屉：\n“这枚章现在下班了喵。你也快了。”",
    "今日远征已经锁定，无法取消。\n\n咪露笑眯眯地摇头：\n“名单进锅了喵，现在开盖会影响口感。”",
  ]);
}

function settlementRunningText(): string {
  return sample([
    "今日远征正在结算中。\n\n咪露正飞快翻着登记簿：\n“再催就把你的战报揉成团喵，反正还没盖章。”",
    "今日远征正在结算中。\n\n咪露抱着一叠战报跑过柜台：\n“别催喵，催急了就按最惨的那版发。”",
    "今日远征正在结算中。\n\n咪露的笔尖飞快乱晃：\n“正在算喵。有人赚钱，有人变成教材。”",
  ]);
}

function closedText(): string {
  return sample([
    "今日裂隙已经关闭，远征队正在公会大厅休整。\n明天再来吧。\n\n咪露抱着登记簿，尾巴慢悠悠地晃：\n“现在申请也没用喵。不如先在群里发「图来」看看？”",
    "今日裂隙已经关闭，远征队正在公会大厅休整。\n明天再来吧。\n\n咪露把门牌翻到“打烊”：\n“现在报名太晚啦喵。去群里发「图来」，酒馆老板可能会理你。”",
    "今日裂隙已经关闭，远征队正在公会大厅休整。\n明天再来吧。\n\n咪露抱着热茶缩在柜台后面：\n“下班后的裂隙不接客喵。你也去酒馆休息，顺便试试「图来」。”",
  ]);
}

function formatErrorText(): string {
  return sample([
    "格式不太对。\n\n试试：\n远征 冒险 50\n远征 疯狂 梭哈\n\n咪露歪着头看了半天：\n“这张申请表像被史莱姆嚼过又吐出来了喵。”",
    "格式不太对。\n\n试试：\n远征 冒险 50\n远征 疯狂 梭哈\n\n咪露把申请表倒过来看：\n“嗯，倒过来也还是不对喵。”",
    "格式不太对。\n\n试试：\n远征 冒险 50\n远征 疯狂 梭哈\n\n咪露递来一支笔：\n“重新写喵。这张申请表已经开始自己喊救命了。”",
  ]);
}

function insufficientPointsText(): string {
  return sample([
    "你的积分不够。\n\n远征至少需要 10 积分。\n咪露用爪子把申请表推回来：\n“勇气满分，钱包零分喵。”",
    "你的积分不够。\n\n远征至少需要 10 积分。\n咪露把申请表压在爪子下面：\n“钱包太轻喵，裂隙入口的风会把你吹回来。”",
    "你的积分不够。\n\n远征至少需要 10 积分。\n咪露看了看账本：\n“勇气已经到账，积分还在路上喵。”",
  ]);
}

function stakeTooLowText(): string {
  return sample([
    "投入太少。\n\n远征至少需要 10 积分。\n咪露用爪子敲了敲申请表：\n“这点押金连史莱姆都请不动喵。”",
    "投入太少。\n\n远征至少需要 10 积分。\n咪露认真摇头：\n“低于 10 积分，连公会的倒霉祝福都启动不了喵。”",
    "投入太少。\n\n远征至少需要 10 积分。\n咪露把硬币推回来：\n“这点不叫押金喵，这叫给裂隙的小费。”",
  ]);
}

function stakeTooHighText(): string {
  return sample([
    "投入过高。\n\n报名最多可投入当前积分的 80%。\n咪露啪地按住你的手：\n“不可以全押喵，破产冒险者会弄脏公会地板。”",
    "投入过高。\n\n报名最多可投入当前积分的 80%。\n咪露扣住登记簿：\n“不许现在就把钱包掏空喵，公会还想明天继续坑你。”",
    "投入过高。\n\n报名最多可投入当前积分的 80%。\n咪露把超出的部分拍回去：\n“太贪心会被裂隙闻到喵。先留点命和积分。”",
  ]);
}

function cancelledText(balance: number): string {
  return renderTemplate(sample([
    "已取消今日远征，投入积分已返还。\n当前积分：{balance}\n\n咪露把任务牌塞回抽屉，懒洋洋地打了个哈欠：\n“逃跑也算战术喵。虽然一点都不帅。”",
    "已取消今日远征，投入积分已返还。\n当前积分：{balance}\n\n咪露把你的名牌摘下来：\n“很好喵，今天选择活着下班。虽然没什么戏剧性。”",
    "已取消今日远征，投入积分已返还。\n当前积分：{balance}\n\n咪露收回申请表：\n“撤退成功喵。放心，裂隙不会伤心，它明天还会等你。”",
  ]), { balance });
}

function notRegisteredCancelText(): string {
  return sample([
    "你今天还没有报名远征。\n\n咪露看着空空的登记簿，尾巴晃了一下：\n“你还没出发就想取消，预判得很熟练喵。”",
    "你今天还没有报名远征。\n\n咪露翻到空白页：\n“还没上车就喊停车喵，你的安全意识领先大家一整天。”",
    "你今天还没有报名远征。\n\n咪露把取消章举起来又放下：\n“没有可以取消的东西喵。要不先发送「远征」制造一点？”",
  ]);
}

function noReportText(): string {
  return sample([
    "今天没有你的远征记录。\n\n咪露翻了翻登记簿，露出甜甜的笑：\n“你今天明明没出门喵，不可以假装自己刚拯救世界。”",
    "今天没有你的远征记录。\n\n咪露把登记簿翻给你看：\n“空的喵。你今天的冒险主要发生在想象里。”",
    "今天没有你的远征记录。\n\n咪露眨了眨眼：\n“没有报名就没有战报喵。公会不提供梦游结算。”",
    "今天没有你的远征记录。\n\n咪露把笔夹到耳朵后面：\n“想看战报的话，先发送「远征」制造一点危险喵。”",
  ]);
}

function reportPendingText(): string {
  return sample([
    `今日远征尚未结算。\n\n结算时间：${EXPEDITION_SETTLEMENT_CUTOFF}\n咪露趴在柜台上看钟：\n“急什么喵？再催的话，咪露就把你的战报压到最下面。”`,
    `今日远征尚未结算。\n\n结算时间：${EXPEDITION_SETTLEMENT_CUTOFF}\n咪露趴在登记簿上：\n“还没到点喵。现在偷看战报，就像偷看还没煮熟的汤。”`,
    `今日远征尚未结算。\n\n结算时间：${EXPEDITION_SETTLEMENT_CUTOFF}\n咪露晃了晃尾巴：\n“战报还在路上喵，可能走着走着就摔了。”`,
    `今日远征尚未结算。\n\n结算时间：${EXPEDITION_SETTLEMENT_CUTOFF}\n咪露用爪子压住纸页：\n“急什么喵，命运正在慢慢写错别字。”`,
  ]);
}

function noRelicText(): string {
  return sample([
    "你当前没有遗物。\n\n咪露递来一个空盒子，认真地点点头：\n“给，至少看起来像你有战利品了喵。”",
    "你当前没有遗物。\n\n咪露往盒子里吹了口气：\n“现在里面装的是空气喵。品质还挺纯。”",
    "你当前没有遗物。\n\n咪露递来一个标签：\n“可以先贴上‘未来会有’喵，听起来比较体面。”",
    "你当前没有遗物。\n\n咪露看了看你的背包：\n“干净得像刚被裂隙洗劫过喵。”",
  ]);
}

function emptyRankingText(): string {
  return sample([
    "当前还没有人站上远征排行。\n\n咪露擦了擦空白榜单：\n“今天大家都好谨慎喵，真无聊。”",
    "当前还没有人站上远征排行。\n\n咪露把榜单挂正：\n“榜上没人喵。今天的勇气都在排队观望。”",
    "当前还没有人站上远征排行。\n\n咪露敲了敲空榜：\n“这么大一张榜，居然没人来丢脸喵。”",
    "当前还没有人站上远征排行。\n\n咪露托着脸：\n“没有幸存者，也没有传奇，只有一块很寂寞的木板喵。”",
  ]);
}

function expeditionCommandMenuText(): string {
  return [
    "远征指令菜单。",
    "",
    "咪露把公会菜单牌往柜台上一拍：",
    "“想进裂隙、想看热闹、想给别人添乱，都从这里开始喵。”",
    "",
    "以下是当前版本支持的全部游戏指令，部分指令会受时间和报名状态限制。",
    "",
    "报名与调整：",
    "远征",
    "远征 稳健 20",
    "远征 冒险 50",
    "远征 疯狂 100",
    "远征 梭哈",
    "远征 稳健 梭哈",
    "远征 冒险 梭哈",
    "远征 疯狂 梭哈",
    "取消远征",
    "",
    "临门一爪：",
    "加码",
    "",
    "围观与添乱：",
    "祝福 @玩家",
    "毒奶 @玩家",
    "我的施法",
    "",
    "查询：",
    "我的战报",
    "我的遗物",
    "远征排行",
    "远征指令",
  ].join("\n");
}

function appendCommandMenuHint(text: string): string {
  return `${text}\n\n发送「远征指令」可以查看完整菜单。`;
}

function bossDefeatedText(boss: string, nextBoss: string): string {
  return renderTemplate(sample([
    "裂隙污染被彻底净化了。\n\n世界 Boss「{boss}」在一阵不太体面的尖叫中消失。\n咪露把新的通缉令「{nextBoss}」钉上任务板：\n“恭喜各位喵。坏消息是，下一只更大。”",
    "裂隙污染被彻底净化了。\n\n世界 Boss「{boss}」的名字从通缉令上慢慢褪色。\n咪露把旧纸揉成团：\n“干得漂亮喵。现在可以开始担心下一张通缉令了。”",
    "裂隙污染被彻底净化了。\n\n世界 Boss「{boss}」被净化成一阵很没面子的烟。\n咪露踮脚看了看远方：\n“胜利啦喵。趁新的麻烦还没排队进门，先鼓掌。”",
    "裂隙污染被彻底净化了。\n\n世界 Boss「{boss}」终于停止往公会账本上泼黑泥。\n咪露把账本擦干净：\n“好消息是它没了。坏消息是账还在喵。”",
    "裂隙污染被彻底净化了。\n\n世界 Boss「{boss}」倒下时，裂隙深处传来一声很不甘心的咕噜。\n咪露把爪印盖在通缉令上：\n“本轮收工喵。大家的倒霉很有用。”",
  ]), { boss, nextBoss });
}

function castSuccessText(cast: ExpeditionCastRecord, remainingCasts: number): string {
  if (cast.castType === "blessing") {
    return sample([
      `祝福已登记。\n\n目标：${cast.targetName}\n今日剩余施法名额：${remainingCasts}\n\n咪露在${cast.targetName}的申请表旁边贴了一枚小小的亮片：\n“祝福收到了喵。至于命运收不收，要等 17:50 才知道。”`,
      `祝福已登记。\n\n目标：${cast.targetName}\n今日剩余施法名额：${remainingCasts}\n\n咪露贴上一枚亮晶晶的小星星：\n“祝福投递成功喵。希望它路上别被裂隙吃掉。”`,
      `祝福已登记。\n\n目标：${cast.targetName}\n今日剩余施法名额：${remainingCasts}\n\n咪露认真盖章：\n“收到喵。你给的是祝福，命运回什么就不一定了。”`,
    ]);
  }

  return sample([
    `毒奶已登记。\n\n目标：${cast.targetName}\n今日剩余施法名额：${remainingCasts}\n\n咪露笑眯眯地在登记簿上画了个黑色小爪印：\n“好耶，又有人对朋友的运气下手了喵。”`,
    `毒奶已登记。\n\n目标：${cast.targetName}\n今日剩余施法名额：${remainingCasts}\n\n咪露画了个黑色小爱心：\n“坏坏的关心收到了喵，友情真是可怕。”`,
    `毒奶已登记。\n\n目标：${cast.targetName}\n今日剩余施法名额：${remainingCasts}\n\n咪露捂嘴偷笑：\n“你们群友之间的祝愿，怎么有一股陷阱味喵。”`,
  ]);
}

function castModifiedText(cast: ExpeditionCastRecord): string {
  if (cast.castType === "blessing") {
    return sample([
      `施法已修改。\n\n目标：${cast.targetName}\n当前施法：祝福\n\n咪露把黑爪印擦掉，换上亮片：\n“突然变善良了喵？咪露先记下，等会儿看有没有反转。”`,
      `施法已修改。\n\n目标：${cast.targetName}\n当前施法：祝福\n\n咪露重新贴好亮片：\n“改成祝福了喵。友情临时回暖，命运正在旁听。”`,
    ]);
  }

  return sample([
    `施法已修改。\n\n目标：${cast.targetName}\n当前施法：毒奶\n\n咪露把刚贴上的祝福亮片抠下来，换成黑色小爪印：\n“刚才还祝福，现在就毒奶。你们人类的友情真好看喵。”`,
    `施法已修改。\n\n目标：${cast.targetName}\n当前施法：毒奶\n\n咪露把亮片撕下来：\n“好快的变脸喵。刚才是朋友，现在是节目效果。”`,
  ]);
}

function castTargetMissingText(castType: ExpeditionCastType): string {
  return `请指定要${castTypeLabel(castType)}的玩家。\n\n试试：${castTypeLabel(castType)} @玩家\n咪露举起小法杖：\n“要有收件人喵，不然命运不知道该砸谁。”`;
}

function castTargetNotRegisteredText(): string {
  return sample([
    "不能施法，目标今天还没有报名远征。\n\n咪露翻了翻登记簿：\n“这个人今天没上车喵。你想毒奶空气吗？”",
    "不能施法，目标今天还没有报名远征。\n\n咪露翻完名单：\n“人都没在车上喵，你这口奶喷到公会墙上了。”",
    "不能施法，目标今天还没有报名远征。\n\n咪露敲了敲空白栏：\n“先让对方发送「远征」喵。不然命运找不到收件人。”",
  ]);
}

function castSelfText(): string {
  return sample([
    "不能对自己施法。\n\n咪露按住你的手：\n“自己奶自己不算喵，这叫心理建设。”",
    "不能对自己施法。\n\n咪露把你的手推开：\n“自己给自己加戏不算施法喵，最多算热身。”",
    "不能对自己施法。\n\n咪露眯起眼睛：\n“想自助祝福喵？公会暂时不支持这种过于方便的服务。”",
  ]);
}

function castLimitText(): string {
  return sample([
    "今天的施法名额已经用完。\n\n每人每天最多 3 次。\n咪露把你的小法杖收走：\n“今天已经做法 3 次啦。再念下去，公会地板要冒烟了喵。”",
    "今天的施法名额已经用完。\n\n每人每天最多 3 次。\n咪露把记录本合上：\n“嘴巴今天业绩达标了喵，剩下的交给别人添乱。”",
    "今天的施法名额已经用完。\n\n每人每天最多 3 次。\n咪露收走小法杖：\n“不许再念了喵，再念命运都要拉黑你。”",
  ]);
}

function castClosedText(): string {
  return sample([
    "今日远征已经关闭，不能再祝福或毒奶。\n\n咪露抱着已经锁好的登记簿：\n“现在才想动嘴喵？命运已经开始点名了。”",
    "今日远征已经关闭，不能再祝福或毒奶。\n\n咪露把登记簿锁进柜子：\n“现在说什么都晚啦喵，命运已经开始翻牌。”",
    "今日远征已经关闭，不能再祝福或毒奶。\n\n咪露竖起尾巴：\n“嘴慢一步喵。下次记得在 17:50 前开口。”",
  ]);
}

function myCastsText(casts: ExpeditionCastRecord[]): string {
  const castList = casts
    .map((cast, index) => `${index + 1}. ${castTypeLabel(cast.castType)} ${cast.targetName}`)
    .join("\n");

  return sample([
    `今日施法记录：\n${castList}\n\n咪露翻了翻记录：\n“今日发言证据都在这里喵，想赖账也没用。”`,
    `今日施法记录：\n${castList}\n\n咪露一条条念完：\n“嗯，很精彩喵。你的嘴今天没有白上班。”`,
  ]);
}

function myCastsEmptyText(): string {
  return sample([
    "今天还没有施法记录。\n\n咪露把空白小本子递过来：\n“还没祝福，也还没毒奶喵。你的嘴今天很安静。”",
    "今天还没有施法记录。\n\n咪露递来一张空白便签：\n“还没人被你祝福，也还没人被你毒奶。今天的命运少了一点噪音喵。”",
    "今天还没有施法记录。\n\n咪露晃了晃小法杖：\n“安静得不像你喵。发送「祝福 @玩家」或者「毒奶 @玩家」试试？”",
  ]);
}

function ledgerKey(entry: ExpeditionEntryRecord, action: string): string {
  return `${EXPEDITION_PLUGIN_ID}:${entry.dateKey}:${entry.sessionId}:${entry.senderId}:${action}:${entry.revision}`;
}

function settlementOperationKey(dateKey: string): string {
  return `settlement:${dateKey}`;
}

function boostReminderOperationKey(dateKey: string): string {
  return `boost-reminder:${dateKey}`;
}

function randomEventOperationKey(dateKey: string, slotKey: string): string {
  return `random-event:${dateKey}:${slotKey}`;
}

function randomEventPlanKey(dateKey: string): string {
  return `random-event-plan:${dateKey}`;
}

function isWithinBoostWindow(input: Date): boolean {
  const dateKey = getBusinessDateKey(input, EXPEDITION_TIMEZONE);
  const boostStartAt = getDailyCutoffAt(dateKey, BOOST_WINDOW_START, EXPEDITION_TIMEZONE);
  const settlementAt = getDailyCutoffAt(dateKey, EXPEDITION_SETTLEMENT_CUTOFF, EXPEDITION_TIMEZONE);
  const time = input.getTime();
  return time >= boostStartAt.getTime() && time < settlementAt.getTime();
}

function isWithinRandomEventWindow(input: Date): boolean {
  const dateKey = getBusinessDateKey(input, EXPEDITION_TIMEZONE);
  const windowStartAt = getDailyCutoffAt(dateKey, RANDOM_EVENT_WINDOW_START, EXPEDITION_TIMEZONE);
  const windowEndAt = getDailyCutoffAt(dateKey, RANDOM_EVENT_WINDOW_END, EXPEDITION_TIMEZONE);
  const boostStartAt = getDailyCutoffAt(dateKey, BOOST_WINDOW_START, EXPEDITION_TIMEZONE);
  const settlementAt = getDailyCutoffAt(dateKey, EXPEDITION_SETTLEMENT_CUTOFF, EXPEDITION_TIMEZONE);
  const time = input.getTime();
  return (
    time >= windowStartAt.getTime() &&
    time <= windowEndAt.getTime() &&
    !(time >= boostStartAt.getTime() && time < settlementAt.getTime())
  );
}

function getLocalTimeKey(input: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(input);
}

function pickRandomEventSlots(): string[] {
  const candidates = buildRandomEventSlotCandidates();
  const count = randomIntInclusive(1, 2);
  const slots = new Set<string>();
  while (slots.size < count && slots.size < candidates.length) {
    slots.add(sample(candidates));
  }

  return [...slots].sort();
}

function buildRandomEventSlotCandidates(): string[] {
  const result: string[] = [];
  const startMinutes = toMinutes(RANDOM_EVENT_WINDOW_START);
  const endMinutes = toMinutes(RANDOM_EVENT_WINDOW_END);
  for (
    let minutes = startMinutes;
    minutes <= endMinutes;
    minutes += RANDOM_EVENT_SLOT_INTERVAL_MINUTES
  ) {
    const hour = Math.floor(minutes / 60).toString().padStart(2, "0");
    const minute = (minutes % 60).toString().padStart(2, "0");
    result.push(`${hour}:${minute}`);
  }

  return result;
}

function toMinutes(value: string): number {
  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function previousDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function resolveMentionTarget(context: PluginContext): string | undefined {
  return context.message.mentionedWxids.find((wxid) => wxid !== context.message.senderId);
}

function rollBasisPoints(threshold: number): boolean {
  return randomIntInclusive(1, 10000) <= threshold;
}

function randomIntInclusive(min: number, max: number): number {
  return randomInt(min, max + 1);
}

function sample<T>(items: readonly T[]): T {
  return items[randomIntInclusive(0, items.length - 1)]!;
}

function sampleDifferent(items: readonly string[], current: string): string {
  const candidates = items.filter((item) => item !== current);
  return sample(candidates.length > 0 ? candidates : items);
}

function castTypeLabel(castType: ExpeditionCastType): string {
  return castType === "blessing" ? "祝福" : "毒奶";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maxBy<T>(items: readonly T[], score: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, item) => {
    if (!best || score(item) > score(best)) {
      return item;
    }

    return best;
  }, undefined);
}

function rarityRank(rarity: ExpeditionRelicRarity): number {
  if (rarity === "legendary") return 4;
  if (rarity === "epic") return 3;
  if (rarity === "rare") return 2;
  return 1;
}

function getReportDetailNumber(report: ExpeditionReportRecord, key: string): number {
  const details = report.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return 0;
  }

  const value = details[key];
  return typeof value === "number" ? value : 0;
}

function getReportDetailStringArray(report: ExpeditionReportRecord, key: string): string[] {
  const details = report.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return [];
  }

  const value = details[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function formatPercentBp(value: number): string {
  return `${(value / 100).toFixed(2).replace(/\.00$/, "")}%`;
}

function formatSignedPercentBp(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatPercentBp(Math.abs(value))}`;
}

function formatMultiplierBp(value: number): string {
  return (value / 10000).toFixed(2);
}
