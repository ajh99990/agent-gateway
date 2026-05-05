import { Queue, Worker, type Job, type JobsOptions, type RepeatOptions } from "bullmq";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type {
  EnqueueScheduledJobInput,
  ScheduledJobData,
  ScheduledJobDefinition,
  ScheduledJobOptions,
  ScheduledJobSchedule,
  Scheduler,
  SchedulerJobCounts,
  SchedulerSnapshot,
} from "./types.js";

type SchedulerQueue = Queue<ScheduledJobData, void, string>;
type SchedulerWorker = Worker<ScheduledJobData, void, string>;
type SchedulerJob = Job<ScheduledJobData, void, string>;

export class BullMqScheduler implements Scheduler {
  private readonly queue: SchedulerQueue;
  private readonly worker: SchedulerWorker;
  private readonly jobs = new Map<string, ScheduledJobDefinition<ScheduledJobData>>();
  private started = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    const bullMqOptions = {
      connection: {
        url: config.redisUrl,
        maxRetriesPerRequest: null,
      },
      prefix: `${config.redisKeyPrefix}:bullmq`,
    };

    this.queue = new Queue<ScheduledJobData, void, string>(config.schedulerQueueName, {
      ...bullMqOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 60_000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });

    this.worker = new Worker<ScheduledJobData, void, string>(
      config.schedulerQueueName,
      async (job) => this.processJob(job),
      {
        ...bullMqOptions,
        autorun: false,
        concurrency: config.schedulerWorkerConcurrency,
      },
    );

    this.bindWorkerEvents();
  }

  public registerJob<TData extends ScheduledJobData = ScheduledJobData>(
    definition: ScheduledJobDefinition<TData>,
  ): void {
    if (this.started) {
      throw new Error("Scheduler 已启动，不能再注册新的定时任务");
    }

    const normalizedId = definition.id.trim();
    if (!normalizedId) {
      throw new Error("定时任务 id 不能为空");
    }

    if (this.jobs.has(normalizedId)) {
      throw new Error(`定时任务 id 冲突：${normalizedId}`);
    }

    validateSchedule(definition.schedule, normalizedId);
    this.jobs.set(normalizedId, {
      ...definition,
      id: normalizedId,
      name: definition.name?.trim() || normalizedId,
    } as ScheduledJobDefinition<ScheduledJobData>);
  }

  public async enqueueJob<TData extends ScheduledJobData = ScheduledJobData>(
    input: EnqueueScheduledJobInput<TData>,
  ): Promise<void> {
    const definition = this.getJobDefinition(input.id.trim());
    const jobData = (input.data ?? definition.data ?? {}) as ScheduledJobData;
    const options: JobsOptions = {
      ...toJobsOptions(definition.options),
      ...toJobsOptions(input.options),
    };
    if (input.jobId !== undefined) {
      options.jobId = input.jobId;
    }
    if (input.delayMs !== undefined) {
      options.delay = input.delayMs;
    }

    await this.queue.add(definition.id, jobData, options);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.queue.waitUntilReady();
    await this.worker.waitUntilReady();
    await this.upsertScheduledJobs();

    this.started = true;
    void this.worker.run().catch((error) => {
      this.logger.error({ err: error }, "BullMQ scheduler worker 停止运行");
    });

    this.logger.info(
      {
        queueName: this.config.schedulerQueueName,
        registeredJobs: this.jobs.size,
        scheduledJobs: this.countScheduledJobs(),
        workerConcurrency: this.config.schedulerWorkerConcurrency,
      },
      "BullMQ scheduler 已启动",
    );
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      await this.worker.close();
      await this.queue.close();
      return;
    }

    this.started = false;
    await this.worker.close(false);
    await this.queue.close();
    this.logger.info({ queueName: this.config.schedulerQueueName }, "BullMQ scheduler 已停止");
  }

  public async getSnapshot(): Promise<SchedulerSnapshot> {
    try {
      const counts = await this.queue.getJobCounts(
        "waiting",
        "delayed",
        "active",
        "completed",
        "failed",
      );

      return {
        status: this.started ? "started" : "stopped",
        queueName: this.config.schedulerQueueName,
        workerRunning: this.worker.isRunning(),
        workerConcurrency: this.config.schedulerWorkerConcurrency,
        registeredJobs: this.jobs.size,
        scheduledJobs: this.countScheduledJobs(),
        counts: normalizeCounts(counts),
      };
    } catch (error) {
      return {
        status: "error",
        queueName: this.config.schedulerQueueName,
        workerRunning: this.worker.isRunning(),
        workerConcurrency: this.config.schedulerWorkerConcurrency,
        registeredJobs: this.jobs.size,
        scheduledJobs: this.countScheduledJobs(),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async upsertScheduledJobs(): Promise<void> {
    for (const definition of this.jobs.values()) {
      if (!definition.schedule) {
        continue;
      }

      await this.queue.upsertJobScheduler(
        definition.id,
        toRepeatOptions(definition.schedule, this.config.schedulerDefaultTimezone),
        {
          name: definition.id,
          data: definition.data ?? {},
          opts: toJobsOptions(definition.options),
        },
      );
    }
  }

  private async processJob(job: SchedulerJob): Promise<void> {
    const definition = this.getJobDefinition(job.name);
    this.logger.info(
      {
        schedulerJobId: definition.id,
        bullJobId: job.id,
        attemptsMade: job.attemptsMade,
      },
      "开始执行 BullMQ scheduler job",
    );

    await definition.process({
      data: job.data,
      execution: {
        id: definition.id,
        name: definition.name ?? definition.id,
        bullJobId: job.id,
        attemptsMade: job.attemptsMade,
        timestamp: new Date().toISOString(),
      },
      scheduler: this,
    });
  }

  private getJobDefinition(jobId: string): ScheduledJobDefinition<ScheduledJobData> {
    const definition = this.jobs.get(jobId);
    if (!definition) {
      throw new Error(`未注册的 scheduler job：${jobId}`);
    }

    return definition;
  }

  private countScheduledJobs(): number {
    return Array.from(this.jobs.values()).filter((definition) => definition.schedule).length;
  }

  private bindWorkerEvents(): void {
    this.worker.on("completed", (job) => {
      this.logger.info(
        {
          schedulerJobId: job.name,
          bullJobId: job.id,
          attemptsMade: job.attemptsMade,
        },
        "BullMQ scheduler job 执行完成",
      );
    });

    this.worker.on("failed", (job, error) => {
      this.logger.error(
        {
          err: error,
          schedulerJobId: job?.name,
          bullJobId: job?.id,
          attemptsMade: job?.attemptsMade,
        },
        "BullMQ scheduler job 执行失败",
      );
    });

    this.worker.on("error", (error) => {
      this.logger.error({ err: error }, "BullMQ scheduler worker 异常");
    });
  }
}

function validateSchedule(schedule: ScheduledJobSchedule | undefined, jobId: string): void {
  if (!schedule) {
    return;
  }

  if (schedule.cron !== undefined && schedule.everyMs !== undefined) {
    throw new Error(`定时任务 ${jobId} 不能同时声明 cron 和 everyMs`);
  }

  if (schedule.cron !== undefined && !schedule.cron.trim()) {
    throw new Error(`定时任务 ${jobId} 声明了空 cron`);
  }

  if (
    schedule.everyMs !== undefined &&
    (!Number.isInteger(schedule.everyMs) || schedule.everyMs <= 0)
  ) {
    throw new Error(`定时任务 ${jobId} 的 everyMs 必须是正整数`);
  }
}

function toRepeatOptions(schedule: ScheduledJobSchedule, defaultTimezone: string): RepeatOptions {
  if (schedule.cron !== undefined) {
    return {
      pattern: schedule.cron,
      tz: schedule.timezone ?? defaultTimezone,
      immediately: schedule.immediately,
    };
  }

  return {
    every: schedule.everyMs,
    immediately: schedule.immediately,
  };
}

function toJobsOptions(options: ScheduledJobOptions | undefined): JobsOptions {
  const jobsOptions: JobsOptions = {};
  if (options?.attempts !== undefined) {
    jobsOptions.attempts = options.attempts;
  }
  if (options?.backoff !== undefined) {
    jobsOptions.backoff = options.backoff;
  }
  if (options?.removeOnComplete !== undefined) {
    jobsOptions.removeOnComplete = options.removeOnComplete;
  }
  if (options?.removeOnFail !== undefined) {
    jobsOptions.removeOnFail = options.removeOnFail;
  }
  return jobsOptions;
}

function normalizeCounts(counts: Record<string, number>): SchedulerJobCounts {
  return {
    waiting: counts.waiting ?? 0,
    delayed: counts.delayed ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  };
}
