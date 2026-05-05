import pino from "pino";
import type { AppConfig } from "../config.js";

/**
 * 所有模块共用同一个 logger。
 *
 * 这样做的意义不是“省代码”，而是保证整条消息链路里的日志格式一致：
 * 无论错误来自 SSE、Redis 还是 Graphiti，输出方式都一样，排查时更顺手。
 */
export function createLogger(config: AppConfig) {
  return pino({
    level: config.logLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
