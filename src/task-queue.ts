import type { Logger } from "pino";
import type { QueueSnapshot } from "./types.js";

/**
 * 这是一个非常轻量的内存任务队列。
 *
 * 在当前项目里，它主要服务于“旁路任务”：
 * 主链路已经把消息批次交给 agent-runtime 了，但像 Graphiti 写入这种事情
 * 不值得阻塞主流程，于是就排到这个队列里异步慢慢做。
 *
 * 你可以把它理解成：
 * “同一个 Node 进程里的简化版后台 worker”。
 */
export class TaskQueue {
  private readonly pending: Array<() => Promise<void>> = [];
  private activeCount = 0;
  private stopped = false;

  public constructor(
    private readonly concurrency: number,
    private readonly logger: Logger,
    private readonly name: string,
  ) {}

  /**
   * enqueue 会在“主流程已经决定要做某件旁路工作”时被调用。
   *
   * 例如 event-gateway 刚完成一次群消息批处理后，会把
   * “把 newMessages 写入 Graphiti” 这个动作塞到队列里。
   *
   * 这里不会等待任务执行完才返回，所以主流程可以继续往下走。
   */
  public enqueue(task: () => Promise<void>): void {
    if (this.stopped) {
      this.logger.warn({ queue: this.name }, "任务队列已停止，新的后台任务将被丢弃");
      return;
    }

    this.pending.push(task);
    this.pump();
  }

  /**
   * snapshot 主要给 /health 用。
   *
   * 当你在排查“为什么 Graphiti 看起来慢了”时，
   * 这个快照能告诉你：当前有多少任务还在排队、多少任务正在执行。
   */
  public snapshot(): QueueSnapshot {
    return {
      pending: this.pending.length,
      running: this.activeCount,
    };
  }

  /**
   * stop 在进程退出时调用。
   *
   * 当前策略比较简单：
   * 1. 不再接收新任务
   * 2. 清空还没开始执行的任务
   *
   * 这是 MVP 的取舍，目的是让停机逻辑更直接。
   */
  public stop(): void {
    this.stopped = true;
    this.pending.length = 0;
  }

  /**
   * pump 是队列真正“开始干活”的地方。
   *
   * 每次 enqueue 都会触发一次 pump。pump 会检查：
   * - 队列有没有停止
   * - 当前并发数有没有达到上限
   * - pending 里还有没有待执行任务
   *
   * 满足条件就启动任务；任务结束后再递归触发下一轮 pump，
   * 这样整个队列就会持续往前推进。
   */
  private pump(): void {
    while (!this.stopped && this.activeCount < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) {
        return;
      }

      // activeCount 表示“当前有多少任务正在后台执行”。
      this.activeCount += 1;
      void task()
        .catch((error) => {
          this.logger.error({ err: error, queue: this.name }, "后台任务执行失败");
        })
        .finally(() => {
          // 不管任务成功还是失败，都要把占用的并发位释放掉。
          this.activeCount -= 1;
          this.pump();
        });
    }
  }
}
