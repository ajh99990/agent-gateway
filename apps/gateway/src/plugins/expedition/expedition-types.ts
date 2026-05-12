import type { JsonValue } from "../../db/json.js";

export const EXPEDITION_PLUGIN_ID = "expedition";
export const EXPEDITION_TIMEZONE = "Asia/Shanghai";
export const EXPEDITION_SETTLEMENT_CUTOFF = "17:50";

export type ExpeditionStrategy = "steady" | "adventure" | "crazy";
export type ExpeditionEntryStatus = "registered" | "cancelled" | "settled";
export type ExpeditionOutcome = "survived" | "dead";
export type ExpeditionRelicRarity = "common" | "rare" | "epic" | "legendary";
export type ExpeditionCastType = "blessing" | "jinx";
export type ExpeditionRandomEventType = "flavor" | "global" | "targeted" | "tradeoff" | "idle";
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
  boosted: boolean;
  boostStake: number;
  boostedAt?: Date;
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

export interface ExpeditionCastRecord {
  id: number;
  sessionId: string;
  groupName?: string;
  dateKey: string;
  casterId: string;
  casterName: string;
  targetId: string;
  targetName: string;
  castType: ExpeditionCastType;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpeditionRandomEventEffectValue {
  advanceDelta?: number;
  survivalBpDelta?: number;
  multiplierBpDelta?: number;
  dropRateBpDelta?: number;
  qualityDelta?: number;
  purificationBpDelta?: number;
  rewardPoints?: number;
}

export interface ExpeditionRandomEventRecord {
  id: number;
  sessionId: string;
  groupName?: string;
  dateKey: string;
  eventKey: string;
  eventType: ExpeditionRandomEventType;
  title: string;
  messageText: string;
  targetSenderId?: string;
  targetSenderName?: string;
  targetEntryId?: number;
  targetEntryRevision?: number;
  effectValue: ExpeditionRandomEventEffectValue;
  createdAt: Date;
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
  boosted: boolean;
  boostStake: number;
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
