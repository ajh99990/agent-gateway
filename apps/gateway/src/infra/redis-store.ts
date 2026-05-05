import crypto from "node:crypto";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/**
 * Redis 在这个 MVP 里只负责两类轻量状态：
 * 1. 入站消息去重，避免同一条上游事件被重复处理。
 * 2. 会话级锁和高水位，避免同一群并发跑多个 agent run。
 *
 * 你可以把它理解成 event-gateway 的“外部状态抽屉”：
 * 平时大部分临时状态在内存里，但一涉及到跨时刻、跨重试、跨实例仍然要成立的状态，
 * 就放到 Redis。
 */
export class RedisStore {
  private readonly redis: Redis;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    this.redis.on("error", (error: unknown) => {
      this.logger.error({ err: error }, "Redis 连接异常，请检查本机 Redis 是否正常运行");
    });
  }

  /**
   * ping 主要在两个地方使用：
   * 1. 服务启动时，确认 Redis 可用
   * 2. /health 生成快照时，判断 Redis 当前是不是还通
   */
  public async ping(): Promise<void> {
    await this.redis.ping();
  }

  public async claimInboundMessageKey(source: string, messageKey: string): Promise<boolean> {
    // 对主链路来说，去重对象是“某个消息源的一条入站事件”。
    // 这里暂时复用原来的 TTL 配置，避免配置面先膨胀。
    const result = await this.redis.set(
      this.key(`inbound:${source}:${messageKey}`),
      "1",
      "EX",
      this.config.sseDedupeTtlSeconds,
      "NX",
    );
    return result === "OK";
  }

  public async getCommittedLocalId(sessionId: string): Promise<number | null> {
    // committed-local-id 表示这个群里“已经成功交给 agent-runtime 处理过”的最后一条消息。
    // 后续补拉 /messages 时，我们就用它来过滤出真正的新消息。
    const raw = await this.redis.get(this.key(`session:${sessionId}:committed-local-id`));
    if (!raw) {
      return null;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  public async setCommittedLocalId(sessionId: string, localId: number): Promise<void> {
    // 只有当一轮 flush 已经成功调用过 agent-runtime 后，才会推进这个值。
    await this.redis.set(this.key(`session:${sessionId}:committed-local-id`), String(localId));
  }

  public async getValue(suffix: string): Promise<string | null> {
    return this.redis.get(this.key(suffix));
  }

  public async setValue(suffix: string, value: string): Promise<void> {
    await this.redis.set(this.key(suffix), value);
  }

  public async acquireRunLock(sessionId: string): Promise<string | null> {
    // 锁是按群维度的。MVP 虽然默认单进程，但这里先把同群互斥做好，
    // 后面即使扩成多实例，也不至于一个群同时跑多个判断。
    const token = crypto.randomUUID();
    const result = await this.redis.set(
      this.key(`lock:${sessionId}`),
      token,
      "EX",
      this.config.runLockTtlSeconds,
      "NX",
    );

    return result === "OK" ? token : null;
  }

  public async releaseRunLock(sessionId: string, token: string): Promise<void> {
    // 只有持有锁的那一方才能释放，避免误删别人刚拿到的新锁。
    await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, this.key(`lock:${sessionId}`), token);
  }

  /**
   * disconnect 在进程退出阶段调用。
   *
   * 这一步不影响业务语义，但能让 Redis 连接更干净地收尾，
   * 少留一些“连接被强制中断”的噪音。
   */
  public async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  private key(suffix: string): string {
    // 所有 key 都统一挂在配置的前缀下面，避免跟别的项目混在一起。
    return `${this.config.redisKeyPrefix}:${suffix}`;
  }
}
