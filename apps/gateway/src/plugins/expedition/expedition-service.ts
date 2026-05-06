import { randomInt } from "node:crypto";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../db/client.js";
import type { PointsService } from "../../db/services/index.js";
import { getBusinessDateKey, getDailyCutoffAt, isBeforeDailyCutoff } from "../../time.js";
import type {
  PluginContext,
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
import { ExpeditionStore } from "./expedition-store.js";
import type {
  ExpeditionEntryPlan,
  ExpeditionEntryRecord,
  ExpeditionOutcome,
  ExpeditionPlayerRecord,
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
const BOOST_MULTIPLIER_BONUS_BP = 5000;
const BOOST_SURVIVAL_PENALTY_BP = 1000;

const STRATEGY_CONFIG: Record<ExpeditionStrategy, {
  advanceMin: number;
  advanceMax: number;
  survivalBp: number;
  multiplierMinBp: number;
  multiplierMaxBp: number;
  dropRateBp: number;
  qualityModifier: number;
  purificationMultiplierBp: number;
}> = {
  steady: {
    advanceMin: 2,
    advanceMax: 4,
    survivalBp: 9000,
    multiplierMinBp: 11000,
    multiplierMaxBp: 15000,
    dropRateBp: 2000,
    qualityModifier: -20,
    purificationMultiplierBp: 7000,
  },
  adventure: {
    advanceMin: 4,
    advanceMax: 7,
    survivalBp: 7200,
    multiplierMinBp: 15000,
    multiplierMaxBp: 28000,
    dropRateBp: 5000,
    qualityModifier: 0,
    purificationMultiplierBp: 10000,
  },
  crazy: {
    advanceMin: 7,
    advanceMax: 12,
    survivalBp: 4800,
    multiplierMinBp: 30000,
    multiplierMaxBp: 80000,
    dropRateBp: 8000,
    qualityModifier: 40,
    purificationMultiplierBp: 15000,
  },
};

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
  operationRuns: PluginOperationRunStore;
  sendMessage(input: SendMessageInput): Promise<void>;
  logger: Logger;
}

interface ExpeditionBonuses {
  survivalBonusBp: number;
  multiplierBonusBp: number;
  diveBonus: number;
  dropRateBonusBp: number;
  qualityBonus: number;
  purificationBonusBp: number;
  curseSurvivalPenaltyBp: number;
}

interface SettlementResult {
  report: ExpeditionReportRecord;
  relic?: ExpeditionRelicRecord;
}

export class ExpeditionService {
  public constructor(private readonly options: ExpeditionServiceOptions) {}

  public async handleMessage(context: PluginContext): Promise<PluginHandleResult> {
    const content = context.content.trim();
    if (content === "取消远征") {
      return this.replyToSender(await this.cancelEntry(context));
    }

    if (content === "加码") {
      return this.replyToSender(await this.boostEntry(context));
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
      return "你今天还没有报名远征。\n\n咪露看着空空的登记簿，尾巴晃了一下：\n“你还没出发就想取消，预判得很熟练喵。”";
    }

    return `已取消今日远征，投入积分已返还。\n当前积分：${result.balance}\n\n咪露把任务牌塞回抽屉，懒洋洋地打了个哈欠：\n“逃跑也算战术喵。虽然一点都不帅。”`;
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
      return `今日远征尚未结算。\n\n结算时间：${EXPEDITION_SETTLEMENT_CUTOFF}\n咪露趴在柜台上看钟：\n“急什么喵？再催的话，咪露就把你的战报压到最下面。”`;
    }

    return "今天没有你的远征记录。\n\n咪露翻了翻登记簿，露出甜甜的笑：\n“你今天明明没出门喵，不可以假装自己刚拯救世界。”";
  }

  private async getMyRelics(context: PluginContext): Promise<string> {
    const relics = await this.options.store.listRecentActiveRelics(
      context.sessionId,
      context.message.senderId,
      10,
    );
    if (relics.length === 0) {
      return "你当前没有遗物。\n\n咪露递来一个空盒子，认真地点点头：\n“给，至少看起来像你有战利品了喵。”";
    }

    const allRelics = await this.options.store.listActiveRelics(
      context.sessionId,
      context.message.senderId,
    );
    const bonuses = collectBonuses(allRelics);
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
      return "当前还没有人站上远征排行。\n\n咪露擦了擦空白榜单：\n“今天大家都好谨慎喵，真无聊。”";
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
    const results: SettlementResult[] = [];
    let totalPurification = 0;

    for (const entry of entries) {
      const player = await store.getOrCreatePlayer({
        sessionId: entry.sessionId,
        senderId: entry.senderId,
        senderName: entry.senderName,
      });
      const relics = await store.listActiveRelics(entry.sessionId, entry.senderId);
      const result = await this.settleEntry(store, points, entry, player, relics, world.bossName);
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
    bossName: string,
  ): Promise<SettlementResult> {
    const config = STRATEGY_CONFIG[entry.strategy];
    const bonuses = collectBonuses(relics);
    const advance = randomIntInclusive(config.advanceMin, config.advanceMax);
    const targetDepth = player.currentDepth + advance + bonuses.diveBonus;
    const boostSurvivalPenaltyBp = entry.boosted ? BOOST_SURVIVAL_PENALTY_BP : 0;
    const boostMultiplierBonusBp = entry.boosted ? BOOST_MULTIPLIER_BONUS_BP : 0;
    const survivalRateBp = clamp(
      config.survivalBp
        - targetDepth * 10
        + bonuses.survivalBonusBp
        - bonuses.curseSurvivalPenaltyBp
        - boostSurvivalPenaltyBp,
      500,
      9500,
    );
    const survived = rollBasisPoints(survivalRateBp);
    const multiplierBp = randomIntInclusive(config.multiplierMinBp, config.multiplierMaxBp)
      + bonuses.multiplierBonusBp
      + boostMultiplierBonusBp;
    const rewardPoints = survived ? Math.floor(entry.stake * multiplierBp / 10000) : 0;
    const basePurification = Math.floor(targetDepth * config.purificationMultiplierBp / 10000);
    const finalPurification = Math.floor(basePurification * (10000 + bonuses.purificationBonusBp) / 10000);
    const normalPurification = survived ? finalPurification : Math.floor(finalPurification * 0.3);
    const specialEvent = targetDepth >= 30 && rollBasisPoints(500)
      ? {
          text: renderTemplate(sample(SPECIAL_EVENT_TEMPLATES), {
            player: entry.senderName,
            depth: targetDepth,
            boss: bossName,
          }),
          purification: targetDepth * 3,
        }
      : undefined;
    const purification = normalPurification + (specialEvent?.purification ?? 0);
    const finalDepth = survived ? targetDepth : 0;
    let relic: ExpeditionRelicRecord | undefined;

    if (survived) {
      await points.earn({
        sessionId: entry.sessionId,
        senderId: entry.senderId,
        amount: rewardPoints,
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

      const dropRateBp = Math.min(
        config.dropRateBp + targetDepth * 20 + bonuses.dropRateBonusBp,
        9000,
      );
      if (rollBasisPoints(dropRateBp)) {
        relic = await store.insertRelic(createRelic(entry, targetDepth, bonuses.qualityBonus));
      }
    } else {
      await store.deactivateActiveRelics(entry.sessionId, entry.senderId);
    }

    await store.updatePlayerAfterSettlement({
      sessionId: entry.sessionId,
      senderId: entry.senderId,
      senderName: entry.senderName,
      survived,
      finalDepth,
      purification,
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
      outcome: survived ? "survived" : "dead",
      startDepth: player.currentDepth,
      targetDepth,
      finalDepth,
      survivalRateBasisPoints: survivalRateBp,
      multiplierBasisPoints: multiplierBp,
      boosted: entry.boosted,
      boostStake: entry.boostStake,
      rewardPoints,
      lostPoints: survived ? 0 : entry.stake,
      purification,
      deathReason: survived ? undefined : chooseDeathReason(entry, relics, targetDepth),
      relicName: relic?.name,
      relicRarity: relic?.rarity,
      specialEventText: specialEvent?.text,
      details: {
        advance,
        relicCountBeforeSettlement: relics.length,
        boostSurvivalPenaltyBp,
        boostMultiplierBonusBp,
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
      message: "你的积分不够。\n\n远征至少需要 10 积分。\n咪露用爪子把申请表推回来：\n“勇气满分，钱包零分喵。”",
    };
  }

  if (stake < MIN_STAKE) {
    return {
      ok: false,
      message: "投入太少。\n\n远征至少需要 10 积分。\n咪露用爪子敲了敲申请表：\n“这点押金连史莱姆都请不动喵。”",
    };
  }

  if (stake > maxStake) {
    return {
      ok: false,
      message: "投入过高。\n\n今日最多可投入当前积分的 80%。\n咪露啪地按住你的手：\n“不可以全押喵，破产冒险者会弄脏公会地板。”",
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

function collectBonuses(relics: ExpeditionRelicRecord[]): ExpeditionBonuses {
  const raw = relics.reduce<ExpeditionBonuses>((acc, relic) => ({
    survivalBonusBp: acc.survivalBonusBp + (relic.effectValue.survivalBonusBp ?? 0),
    multiplierBonusBp: acc.multiplierBonusBp + (relic.effectValue.multiplierBonusBp ?? 0),
    diveBonus: acc.diveBonus + (relic.effectValue.diveBonus ?? 0),
    dropRateBonusBp: acc.dropRateBonusBp + (relic.effectValue.dropRateBonusBp ?? 0),
    qualityBonus: acc.qualityBonus + (relic.effectValue.qualityBonus ?? 0),
    purificationBonusBp: acc.purificationBonusBp + (relic.effectValue.purificationBonusBp ?? 0),
    curseSurvivalPenaltyBp: acc.curseSurvivalPenaltyBp + (relic.effectValue.curseSurvivalPenaltyBp ?? 0),
  }), {
    survivalBonusBp: 0,
    multiplierBonusBp: 0,
    diveBonus: 0,
    dropRateBonusBp: 0,
    qualityBonus: 0,
    purificationBonusBp: 0,
    curseSurvivalPenaltyBp: 0,
  });

  return {
    survivalBonusBp: Math.min(raw.survivalBonusBp, 3000),
    multiplierBonusBp: Math.min(raw.multiplierBonusBp, 30000),
    diveBonus: Math.min(raw.diveBonus, 10),
    dropRateBonusBp: Math.min(raw.dropRateBonusBp, 3000),
    qualityBonus: Math.min(raw.qualityBonus, 120),
    purificationBonusBp: Math.min(raw.purificationBonusBp, 20000),
    curseSurvivalPenaltyBp: Math.min(raw.curseSurvivalPenaltyBp, 4000),
  };
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
      "裂隙污染被彻底净化了。",
      "",
      `世界 Boss「${input.bossName}」在一阵不太体面的尖叫中消失。`,
      `咪露把新的通缉令「${input.nextBossName}」钉上任务板：`,
      "“恭喜各位喵。坏消息是，下一只更大。”",
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
    `裂隙净化：${report.purification}`,
    report.specialEventText,
  ].filter(Boolean).join("\n");
}

function registeredText(entry: ExpeditionEntryRecord, balanceAfter: number, defaultCommand: boolean): string {
  if (defaultCommand) {
    return `报名成功。\n\n今日远征：${STRATEGY_LABELS[entry.strategy]}\n投入积分：${entry.stake}\n剩余积分：${balanceAfter}\n结算时间：${EXPEDITION_SETTLEMENT_CUTOFF}\n\n咪露把默认申请表盖上章：\n“先给你安排冒险档喵。下次想更刺激，可以试试「远征 疯狂 100」或者「远征 疯狂 梭哈」。”`;
  }

  return `报名成功。\n\n今日远征：${STRATEGY_LABELS[entry.strategy]}\n投入积分：${entry.stake}\n剩余积分：${balanceAfter}\n结算时间：${EXPEDITION_SETTLEMENT_CUTOFF}\n\n前台猫娘咪露把你的名字贴上任务板，尾巴轻轻一晃：\n“好耶，又有勇者主动交押金了喵。”`;
}

function modifiedText(entry: ExpeditionEntryRecord, balanceAfter: number): string {
  return `远征计划已修改。\n\n今日远征：${STRATEGY_LABELS[entry.strategy]}\n投入积分：${entry.stake}\n剩余积分：${balanceAfter}\n结算时间：${EXPEDITION_SETTLEMENT_CUTOFF}\n\n咪露盯着申请表，眼睛亮了起来：\n“改计划？哇，今天的事故报告有素材了喵。”`;
}

function unchangedText(entry: ExpeditionEntryRecord, balanceAfter: number): string {
  return `你的远征计划没有变化。\n\n今日远征：${STRATEGY_LABELS[entry.strategy]}\n投入积分：${entry.stake}\n剩余积分：${balanceAfter}\n结算时间：${EXPEDITION_SETTLEMENT_CUTOFF}\n\n咪露用爪子点了点任务板：\n“同一张申请表不用交两遍喵，我还没这么健忘。”`;
}

function boostedText(boostStake: number, totalStake: number, balanceAfter: number): string {
  return `加码成功。\n\n追加投入：${boostStake}\n当前总投入：${totalStake}\n剩余积分：${balanceAfter}\n最终倍率 +0.5\n生还率 -10%\n\n咪露把爪印盖在申请表上：\n“好耶，理智又少了一点喵。”`;
}

function boostInsufficientText(): string {
  return "加码失败，剩余积分不足。\n\n至少需要 10 积分才能加码。\n咪露看了看你的钱包：\n“想法很大，余额很小喵。”";
}

function alreadyBoostedText(): string {
  return "今天已经加码过了。\n\n咪露把爪子收回去：\n“一天只能上头一次喵，公会也怕你太努力。”";
}

function notRegisteredBoostText(): string {
  return "你还没有报名远征，不能加码。\n\n咪露晃了晃空白申请表：\n“连车都没上，就想把油门踩到底喵？”";
}

function nonBoostTimeText(): string {
  return `现在还不能加码。\n\n临门一爪开放时间：${BOOST_WINDOW_START} - 17:49\n咪露舔了舔爪子：\n“别急喵，真正上头的时间还没到。”`;
}

function lockedModifyText(): string {
  return "今日远征已经锁定，无法修改。\n\n咪露把加码申请表压在爪子下面：\n“爪印都盖上去了喵，现在反悔会显得你很清醒。”";
}

function lockedCancelText(): string {
  return "今日远征已经锁定，无法取消。\n\n咪露把登记簿抱紧：\n“都临门一爪了喵，现在逃跑就没有节目效果了。”";
}

function settlementRunningText(): string {
  return "今日远征正在结算中。\n\n咪露正飞快翻着登记簿：\n“再催就把你的战报揉成团喵，反正还没盖章。”";
}

function closedText(): string {
  return "今日裂隙已经关闭，远征队正在公会大厅休整。\n明天再来吧。\n\n咪露抱着登记簿，尾巴慢悠悠地晃：\n“现在申请也没用喵。不如先在群里发「图来」看看？”";
}

function formatErrorText(): string {
  return "格式不太对。\n\n试试：\n远征 冒险 50\n远征 疯狂 梭哈\n\n咪露歪着头看了半天：\n“这张申请表像被史莱姆嚼过又吐出来了喵。”";
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

function isWithinBoostWindow(input: Date): boolean {
  const dateKey = getBusinessDateKey(input, EXPEDITION_TIMEZONE);
  const boostStartAt = getDailyCutoffAt(dateKey, BOOST_WINDOW_START, EXPEDITION_TIMEZONE);
  const settlementAt = getDailyCutoffAt(dateKey, EXPEDITION_SETTLEMENT_CUTOFF, EXPEDITION_TIMEZONE);
  const time = input.getTime();
  return time >= boostStartAt.getTime() && time < settlementAt.getTime();
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

function formatPercentBp(value: number): string {
  return `${(value / 100).toFixed(2).replace(/\.00$/, "")}%`;
}

function formatMultiplierBp(value: number): string {
  return (value / 10000).toFixed(2);
}
