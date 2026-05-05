import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/**
 * getBusinessDateKey 把一个时间转换成指定时区里的业务日期。
 *
 * 插件做“每日任务”“每日报名”“每日签到限制”时，应该使用这个日期键，
 * 而不是直接用服务器本地日期，避免部署机器时区变化影响业务判断。
 */
export function getBusinessDateKey(
  input: Date | string | number = new Date(),
  timezoneName = DEFAULT_TIMEZONE,
): string {
  return dayjs(input).tz(timezoneName).format("YYYY-MM-DD");
}

/**
 * getDailyCutoffAt 返回某个业务日期在指定时区里的截止时刻。
 *
 * 例如 dateKey = "2026-05-03" 且 cutoff = "17:50" 时，
 * 返回的是 Asia/Shanghai 的 2026-05-03 17:50 对应的真实 Date。
 */
export function getDailyCutoffAt(
  dateKey: string,
  cutoff: string,
  timezoneName = DEFAULT_TIMEZONE,
): Date {
  const normalizedDateKey = normalizeDateKey(dateKey);
  const normalizedCutoff = normalizeDailyCutoff(cutoff);
  return dayjs.tz(`${normalizedDateKey} ${normalizedCutoff}:00`, timezoneName).toDate();
}

/**
 * isBeforeDailyCutoff 判断输入时间是否早于当天的每日截止时间。
 *
 * 它适合处理“收到时间 < 17:50 才允许操作”这类规则；如果刚好等于截止时间，
 * 会返回 false，也就是把截止时刻视为已经锁定。
 */
export function isBeforeDailyCutoff(
  input: Date | string | number,
  cutoff: string,
  timezoneName = DEFAULT_TIMEZONE,
): boolean {
  const dateKey = getBusinessDateKey(input, timezoneName);
  const cutoffAt = getDailyCutoffAt(dateKey, cutoff, timezoneName);
  return dayjs(input).isBefore(cutoffAt);
}

function normalizeDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`业务日期格式必须是 YYYY-MM-DD：${value}`);
  }

  return normalized;
}

function normalizeDailyCutoff(value: string): string {
  const normalized = value.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (!match) {
    throw new Error(`每日截止时间格式必须是 HH:mm：${value}`);
  }

  const hour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`每日截止时间超出范围：${value}`);
  }

  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}
