import {
  buildExpeditionModifiers,
} from "./expedition-modifiers.js";
import type {
  ExpeditionModifier,
  ExpeditionModifierSource,
  ExpeditionModifierSummary,
  ExpeditionModifierTotals,
} from "./expedition-modifiers.js";
import type {
  ExpeditionEntryRecord,
  ExpeditionPlayerRecord,
  ExpeditionRelicRecord,
  ExpeditionStrategy,
} from "./expedition-types.js";

export interface ExpeditionStrategyConfig {
  advanceMin: number;
  advanceMax: number;
  survivalBp: number;
  multiplierMinBp: number;
  multiplierMaxBp: number;
  dropRateBp: number;
  qualityModifier: number;
  purificationMultiplierBp: number;
}

export interface ExpeditionResolutionRandom {
  randomIntInclusive(min: number, max: number): number;
  rollBasisPoints(threshold: number): boolean;
}

export interface ExpeditionSpecialEventRenderInput extends Record<string, string | number> {
  player: string;
  depth: number;
  boss: string;
}

export interface ExpeditionSpecialEventResolution {
  text: string;
  purification: number;
}

export interface ExpeditionSettlementResolution {
  modifierSummary: ExpeditionModifierSummary;
  advance: number;
  targetDepth: number;
  finalDepth: number;
  survivalRateBp: number;
  survived: boolean;
  multiplierBp: number;
  rewardPoints: number;
  basePurification: number;
  finalPurification: number;
  normalPurification: number;
  purification: number;
  dropRateBp: number;
  relicDropped: boolean;
  qualityBonus: number;
  boostSurvivalPenaltyBp: number;
  boostMultiplierBonusBp: number;
  specialEvent?: ExpeditionSpecialEventResolution;
}

export const STRATEGY_CONFIG: Record<ExpeditionStrategy, ExpeditionStrategyConfig> = {
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

export function resolveExpeditionSettlement(input: {
  entry: ExpeditionEntryRecord;
  player: ExpeditionPlayerRecord;
  relics: ExpeditionRelicRecord[];
  extraModifiers?: ExpeditionModifier[];
  bossName: string;
  random: ExpeditionResolutionRandom;
  renderSpecialEvent(input: ExpeditionSpecialEventRenderInput): string;
}): ExpeditionSettlementResolution {
  const config = STRATEGY_CONFIG[input.entry.strategy];
  const modifierSummary = buildExpeditionModifiers({
    entry: input.entry,
    relics: input.relics,
    extraModifiers: input.extraModifiers,
  });
  const modifiers = modifierSummary.totals;
  const advance = input.random.randomIntInclusive(config.advanceMin, config.advanceMax);
  const targetDepth = input.player.currentDepth + advance + modifiers.advanceDelta;
  const boostSurvivalPenaltyBp = Math.max(
    0,
    -modifierSummary.bySource.boost.survivalBpDelta,
  );
  const boostMultiplierBonusBp = modifierSummary.bySource.boost.multiplierBpDelta;
  const survivalRateBp = clamp(
    config.survivalBp
      - targetDepth * 10
      + modifiers.survivalBpDelta,
    500,
    9500,
  );
  const survived = input.random.rollBasisPoints(survivalRateBp);
  const multiplierBp = input.random.randomIntInclusive(
    config.multiplierMinBp,
    config.multiplierMaxBp,
  ) + modifiers.multiplierBpDelta;
  const rewardPoints = survived ? Math.floor(input.entry.stake * multiplierBp / 10000) : 0;
  const basePurification = Math.floor(
    targetDepth * config.purificationMultiplierBp / 10000,
  );
  const finalPurification = Math.floor(
    basePurification * (10000 + modifiers.purificationBpDelta) / 10000,
  );
  const normalPurification = survived ? finalPurification : Math.floor(finalPurification * 0.3);
  const specialEvent = targetDepth >= 30 && input.random.rollBasisPoints(500)
    ? {
        text: input.renderSpecialEvent({
          player: input.entry.senderName,
          depth: targetDepth,
          boss: input.bossName,
        }),
        purification: targetDepth * 3,
      }
    : undefined;
  const purification = normalPurification + (specialEvent?.purification ?? 0);
  const finalDepth = survived ? targetDepth : 0;
  const dropRateBp = Math.min(
    config.dropRateBp + targetDepth * 20 + modifiers.dropRateBpDelta,
    9000,
  );
  const relicDropped = survived && input.random.rollBasisPoints(dropRateBp);

  return {
    modifierSummary,
    advance,
    targetDepth,
    finalDepth,
    survivalRateBp,
    survived,
    multiplierBp,
    rewardPoints,
    basePurification,
    finalPurification,
    normalPurification,
    purification,
    dropRateBp,
    relicDropped,
    qualityBonus: modifiers.qualityDelta,
    boostSurvivalPenaltyBp,
    boostMultiplierBonusBp,
    specialEvent,
  };
}

export function modifierTotalsToDetails(totals: ExpeditionModifierTotals): Record<string, number> {
  return {
    advanceDelta: totals.advanceDelta,
    survivalBpDelta: totals.survivalBpDelta,
    multiplierBpDelta: totals.multiplierBpDelta,
    dropRateBpDelta: totals.dropRateBpDelta,
    qualityDelta: totals.qualityDelta,
    purificationBpDelta: totals.purificationBpDelta,
  };
}

export function modifierSourcesToDetails(
  sources: Record<ExpeditionModifierSource, ExpeditionModifierTotals>,
): Record<string, Record<string, number>> {
  return Object.fromEntries(
    Object.entries(sources).map(([source, totals]) => [
      source,
      modifierTotalsToDetails(totals),
    ]),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
