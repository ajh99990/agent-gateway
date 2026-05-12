import type {
  ExpeditionEntryRecord,
  ExpeditionRelicRecord,
} from "./expedition-types.js";

export type ExpeditionModifierSource =
  | "relic"
  | "boost"
  | "blessing"
  | "jinx"
  | "random_event";

export interface ExpeditionModifier {
  source: ExpeditionModifierSource;
  sourceId?: string;
  label: string;
  advanceDelta?: number;
  survivalBpDelta?: number;
  multiplierBpDelta?: number;
  dropRateBpDelta?: number;
  qualityDelta?: number;
  purificationBpDelta?: number;
}

export interface ExpeditionModifierTotals {
  advanceDelta: number;
  survivalBpDelta: number;
  multiplierBpDelta: number;
  dropRateBpDelta: number;
  qualityDelta: number;
  purificationBpDelta: number;
}

export interface ExpeditionRelicBonusSummary {
  survivalBonusBp: number;
  multiplierBonusBp: number;
  diveBonus: number;
  dropRateBonusBp: number;
  qualityBonus: number;
  purificationBonusBp: number;
  curseSurvivalPenaltyBp: number;
}

export interface ExpeditionModifierSummary {
  modifiers: ExpeditionModifier[];
  totals: ExpeditionModifierTotals;
  bySource: Record<ExpeditionModifierSource, ExpeditionModifierTotals>;
  relicBonuses: ExpeditionRelicBonusSummary;
}

const ZERO_TOTALS: ExpeditionModifierTotals = {
  advanceDelta: 0,
  survivalBpDelta: 0,
  multiplierBpDelta: 0,
  dropRateBpDelta: 0,
  qualityDelta: 0,
  purificationBpDelta: 0,
};

const ZERO_RELIC_BONUSES: ExpeditionRelicBonusSummary = {
  survivalBonusBp: 0,
  multiplierBonusBp: 0,
  diveBonus: 0,
  dropRateBonusBp: 0,
  qualityBonus: 0,
  purificationBonusBp: 0,
  curseSurvivalPenaltyBp: 0,
};

export const BOOST_MULTIPLIER_BONUS_BP = 5000;
export const BOOST_SURVIVAL_PENALTY_BP = 1000;

const RELIC_CAPS: ExpeditionRelicBonusSummary = {
  survivalBonusBp: 3000,
  multiplierBonusBp: 30000,
  diveBonus: 10,
  dropRateBonusBp: 3000,
  qualityBonus: 120,
  purificationBonusBp: 20000,
  curseSurvivalPenaltyBp: 4000,
};

export function buildExpeditionModifiers(input: {
  entry: ExpeditionEntryRecord;
  relics: ExpeditionRelicRecord[];
  extraModifiers?: ExpeditionModifier[];
}): ExpeditionModifierSummary {
  return aggregateExpeditionModifiers([
    ...buildRelicModifiers(input.relics),
    ...buildBoostModifiers(input.entry),
    ...(input.extraModifiers ?? []),
  ]);
}

export function buildRelicModifiers(relics: ExpeditionRelicRecord[]): ExpeditionModifier[] {
  return relics.map((relic) => ({
    source: "relic",
    sourceId: String(relic.id),
    label: relic.name,
    advanceDelta: relic.effectValue.diveBonus,
    survivalBpDelta:
      (relic.effectValue.survivalBonusBp ?? 0) -
      (relic.effectValue.curseSurvivalPenaltyBp ?? 0),
    multiplierBpDelta: relic.effectValue.multiplierBonusBp,
    dropRateBpDelta: relic.effectValue.dropRateBonusBp,
    qualityDelta: relic.effectValue.qualityBonus,
    purificationBpDelta: relic.effectValue.purificationBonusBp,
  }));
}

export function buildBoostModifiers(entry: ExpeditionEntryRecord): ExpeditionModifier[] {
  if (!entry.boosted) {
    return [];
  }

  return [
    {
      source: "boost",
      sourceId: String(entry.id),
      label: "临门一爪",
      survivalBpDelta: -BOOST_SURVIVAL_PENALTY_BP,
      multiplierBpDelta: BOOST_MULTIPLIER_BONUS_BP,
    },
  ];
}

export function aggregateExpeditionModifiers(
  modifiers: ExpeditionModifier[],
): ExpeditionModifierSummary {
  const relicBonuses = collectRelicBonuses(modifiers);
  const bySource = createSourceTotals();

  bySource.relic = {
    advanceDelta: relicBonuses.diveBonus,
    survivalBpDelta: relicBonuses.survivalBonusBp - relicBonuses.curseSurvivalPenaltyBp,
    multiplierBpDelta: relicBonuses.multiplierBonusBp,
    dropRateBpDelta: relicBonuses.dropRateBonusBp,
    qualityDelta: relicBonuses.qualityBonus,
    purificationBpDelta: relicBonuses.purificationBonusBp,
  };

  for (const modifier of modifiers) {
    if (modifier.source === "relic") {
      continue;
    }

    addModifierToTotals(bySource[modifier.source], modifier);
  }

  return {
    modifiers,
    totals: sumTotals(Object.values(bySource)),
    bySource,
    relicBonuses,
  };
}

export function collectRelicBonuses(
  modifiersOrRelics: ExpeditionModifier[] | ExpeditionRelicRecord[],
): ExpeditionRelicBonusSummary {
  const modifiers = isRelicRecordArray(modifiersOrRelics)
    ? buildRelicModifiers(modifiersOrRelics)
    : modifiersOrRelics.filter((modifier) => modifier.source === "relic");

  const raw = modifiers.reduce<ExpeditionRelicBonusSummary>((acc, modifier) => {
    const survivalBpDelta = modifier.survivalBpDelta ?? 0;
    return {
      survivalBonusBp: acc.survivalBonusBp + Math.max(0, survivalBpDelta),
      multiplierBonusBp: acc.multiplierBonusBp + (modifier.multiplierBpDelta ?? 0),
      diveBonus: acc.diveBonus + (modifier.advanceDelta ?? 0),
      dropRateBonusBp: acc.dropRateBonusBp + (modifier.dropRateBpDelta ?? 0),
      qualityBonus: acc.qualityBonus + (modifier.qualityDelta ?? 0),
      purificationBonusBp: acc.purificationBonusBp + (modifier.purificationBpDelta ?? 0),
      curseSurvivalPenaltyBp:
        acc.curseSurvivalPenaltyBp + Math.max(0, -survivalBpDelta),
    };
  }, { ...ZERO_RELIC_BONUSES });

  return {
    survivalBonusBp: Math.min(raw.survivalBonusBp, RELIC_CAPS.survivalBonusBp),
    multiplierBonusBp: Math.min(raw.multiplierBonusBp, RELIC_CAPS.multiplierBonusBp),
    diveBonus: Math.min(raw.diveBonus, RELIC_CAPS.diveBonus),
    dropRateBonusBp: Math.min(raw.dropRateBonusBp, RELIC_CAPS.dropRateBonusBp),
    qualityBonus: Math.min(raw.qualityBonus, RELIC_CAPS.qualityBonus),
    purificationBonusBp: Math.min(raw.purificationBonusBp, RELIC_CAPS.purificationBonusBp),
    curseSurvivalPenaltyBp: Math.min(
      raw.curseSurvivalPenaltyBp,
      RELIC_CAPS.curseSurvivalPenaltyBp,
    ),
  };
}

function addModifierToTotals(
  totals: ExpeditionModifierTotals,
  modifier: ExpeditionModifier,
): void {
  totals.advanceDelta += modifier.advanceDelta ?? 0;
  totals.survivalBpDelta += modifier.survivalBpDelta ?? 0;
  totals.multiplierBpDelta += modifier.multiplierBpDelta ?? 0;
  totals.dropRateBpDelta += modifier.dropRateBpDelta ?? 0;
  totals.qualityDelta += modifier.qualityDelta ?? 0;
  totals.purificationBpDelta += modifier.purificationBpDelta ?? 0;
}

function createSourceTotals(): Record<ExpeditionModifierSource, ExpeditionModifierTotals> {
  return {
    relic: { ...ZERO_TOTALS },
    boost: { ...ZERO_TOTALS },
    blessing: { ...ZERO_TOTALS },
    jinx: { ...ZERO_TOTALS },
    random_event: { ...ZERO_TOTALS },
  };
}

function sumTotals(totalsList: ExpeditionModifierTotals[]): ExpeditionModifierTotals {
  return totalsList.reduce<ExpeditionModifierTotals>((acc, totals) => ({
    advanceDelta: acc.advanceDelta + totals.advanceDelta,
    survivalBpDelta: acc.survivalBpDelta + totals.survivalBpDelta,
    multiplierBpDelta: acc.multiplierBpDelta + totals.multiplierBpDelta,
    dropRateBpDelta: acc.dropRateBpDelta + totals.dropRateBpDelta,
    qualityDelta: acc.qualityDelta + totals.qualityDelta,
    purificationBpDelta: acc.purificationBpDelta + totals.purificationBpDelta,
  }), { ...ZERO_TOTALS });
}

function isRelicRecordArray(
  value: ExpeditionModifier[] | ExpeditionRelicRecord[],
): value is ExpeditionRelicRecord[] {
  return value.some((item) => "effectValue" in item);
}
