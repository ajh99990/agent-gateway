import type { JsonValue } from "../../db/json.js";

export const EXPEDITION_PLUGIN_ID = "expedition";
export const EXPEDITION_TIMEZONE = "Asia/Shanghai";
export const EXPEDITION_SETTLEMENT_CUTOFF = "17:50";

export type ExpeditionStrategy = "steady" | "adventure" | "crazy";
export type ExpeditionEntryStatus = "registered" | "cancelled" | "settled";
export type ExpeditionOutcome = "survived" | "dead";
export type ExpeditionRelicRarity = "common" | "rare" | "epic" | "legendary";
export type ExpeditionRelicEffectType =
  | "survival"
  | "greed"
  | "dive"
  | "luck"
  | "purification"
  | "curse";

export interface ExpeditionEntryRecord {
  id: number;
  sessionId: string;
  groupName?: string;
  senderId: string;
  senderName: string;
  dateKey: string;
  strategy: ExpeditionStrategy;
  stake: number;
  allIn: boolean;
  status: ExpeditionEntryStatus;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  settledAt?: Date;
}

export interface ExpeditionPlayerRecord {
  id: number;
  sessionId: string;
  senderId: string;
  senderName: string;
  currentDepth: number;
  runHighDepth: number;
  totalPurification: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpeditionRelicEffectValue {
  survivalBonusBp?: number;
  multiplierBonusBp?: number;
  diveBonus?: number;
  dropRateBonusBp?: number;
  qualityBonus?: number;
  purificationBonusBp?: number;
  curseSurvivalPenaltyBp?: number;
}

export interface ExpeditionRelicRecord {
  id: number;
  sessionId: string;
  senderId: string;
  name: string;
  rarity: ExpeditionRelicRarity;
  effectType: ExpeditionRelicEffectType;
  effectValue: ExpeditionRelicEffectValue;
  description: string;
  acquiredDateKey: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpeditionWorldRecord {
  sessionId: string;
  groupName?: string;
  bossName: string;
  bossMaxPollution: number;
  bossPollution: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpeditionReportRecord {
  id: number;
  sessionId: string;
  groupName?: string;
  dateKey: string;
  senderId: string;
  senderName: string;
  strategy: ExpeditionStrategy;
  stake: number;
  outcome: ExpeditionOutcome;
  startDepth: number;
  targetDepth: number;
  finalDepth: number;
  survivalRateBasisPoints: number;
  multiplierBasisPoints: number;
  rewardPoints: number;
  lostPoints: number;
  purification: number;
  deathReason?: string;
  relicName?: string;
  relicRarity?: ExpeditionRelicRarity;
  specialEventText?: string;
  details?: JsonValue;
  createdAt: Date;
}

export interface ExpeditionRankingRecord {
  senderId: string;
  senderName: string;
  currentDepth: number;
}

export interface ExpeditionEntryPlan {
  strategy: ExpeditionStrategy;
  stake: number;
  allIn: boolean;
}

export interface ExpeditionSettlementSummary {
  sessionId: string;
  groupName?: string;
  dateKey: string;
  participantCount: number;
  survivedCount: number;
  deadCount: number;
  totalPurification: number;
  bossName: string;
  bossPollution: number;
  bossMaxPollution: number;
  bossDefeated: boolean;
  announcementText: string;
}
