import type { JsonValue } from "../db/json.js";

export type ScheduledJobData = Record<string, JsonValue>;

export type ScheduledJobSchedule =
  | {
      cron: string;
      everyMs?: never;
      timezone?: string;
      immediately?: boolean;
    }
  | {
      cron?: never;
      everyMs: number;
      timezone?: string;
      immediately?: boolean;
    };

export interface ScheduledJobBackoffOptions {
  type: "fixed" | "exponential";
  delay: number;
}

export interface ScheduledJobOptions {
  attempts?: number;
  backoff?: ScheduledJobBackoffOptions;
  removeOnComplete?: number;
  removeOnFail?: number;
}

export interface ScheduledJobExecution {
  id: string;
  name: string;
  bullJobId?: string;
  attemptsMade: number;
  timestamp: string;
}

export interface ScheduledJobContext<TData extends ScheduledJobData = ScheduledJobData> {
  data: TData;
  execution: ScheduledJobExecution;
  scheduler: Scheduler;
}

export interface ScheduledJobDefinition<TData extends ScheduledJobData = ScheduledJobData> {
  id: string;
  name?: string;
  description?: string;
  schedule?: ScheduledJobSchedule;
  data?: TData;
  options?: ScheduledJobOptions;
  process(context: ScheduledJobContext<TData>): Promise<void>;
}

export interface EnqueueScheduledJobInput<TData extends ScheduledJobData = ScheduledJobData> {
  id: string;
  data?: TData;
  jobId?: string;
  delayMs?: number;
  options?: ScheduledJobOptions;
}

export interface SchedulerJobCounts {
  waiting: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
}

export interface SchedulerSnapshot {
  status: "started" | "stopped" | "error";
  queueName: string;
  workerRunning: boolean;
  workerConcurrency: number;
  registeredJobs: number;
  scheduledJobs: number;
  counts?: SchedulerJobCounts;
  errorMessage?: string;
}

export interface Scheduler {
  registerJob<TData extends ScheduledJobData = ScheduledJobData>(
    definition: ScheduledJobDefinition<TData>,
  ): void;
  enqueueJob<TData extends ScheduledJobData = ScheduledJobData>(
    input: EnqueueScheduledJobInput<TData>,
  ): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getSnapshot(): Promise<SchedulerSnapshot>;
}
