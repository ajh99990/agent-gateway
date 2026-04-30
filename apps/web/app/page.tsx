import { Activity, CircleAlert, Clock3, Database, Radio, Rows3, Search, Sparkles } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppShell } from "../components/app-shell";
import { StatusPill } from "../components/status-pill";
import { getHealth } from "../lib/gateway-client";
import { requireSession } from "../lib/auth";

export default async function DashboardPage() {
  await requireSession();
  const result = await getHealth();
  const health = result.data;

  return (
    <AppShell active="dashboard">
      <section className="mb-6 overflow-hidden rounded-panel border border-line bg-white shadow-xl shadow-modelblue/5">
        <div className="mesh-band p-5 md:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-modelblue shadow-sm">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Agent Gateway Console
              </div>
              <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-tight text-ink md:text-5xl">
                AI Agent 运行工作台
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted md:text-base">
                以资源平台的方式查看网关健康、SSE 连接和队列状态，快速定位当前服务态势。
              </p>
            </div>
            {health ? (
              <StatusPill tone="good">服务在线</StatusPill>
            ) : (
              <StatusPill tone="warn">无法连接</StatusPill>
            )}
          </div>

          <div className="mt-7 flex max-w-3xl items-center gap-3 rounded-panel border border-line bg-white px-4 py-3 shadow-lg shadow-modelblue/5">
            <Search className="h-5 w-5 text-modelblue" aria-hidden="true" />
            <div className="min-w-0 flex-1 truncate text-sm text-muted">
              搜索健康状态、连接事件、队列任务或插件资源
            </div>
            <div className="hidden rounded-md bg-bluesoft px-2 py-1 font-mono text-xs text-modelblue md:block">
              / health
            </div>
          </div>
        </div>
        <div className="grid border-t border-line bg-white px-5 py-4 text-xs md:grid-cols-4">
          <HeaderDatum label="Redis" value={health?.redis === "ok" ? "OK" : "ERROR"} />
          <HeaderDatum label="SSE" value={health?.sse.connected ? "CONNECTED" : "DISCONNECTED"} />
          <HeaderDatum label="Sessions" value={String(health?.sessions.active ?? "-")} />
          <HeaderDatum label="Uptime" value={health ? formatUptime(health.uptimeSeconds) : "-"} />
        </div>
      </section>

      {result.error ? (
        <Alert className="mb-5" variant="destructive">
          <CircleAlert className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={<Database className="h-4 w-4" aria-hidden="true" />}
          label="Redis"
          value={health?.redis === "ok" ? "OK" : "ERROR"}
          tone={health?.redis === "ok" ? "good" : "warn"}
        />
        <Metric
          icon={<Radio className="h-4 w-4" aria-hidden="true" />}
          label="SSE"
          value={health?.sse.connected ? "CONNECTED" : "DISCONNECTED"}
          tone={health?.sse.connected ? "good" : "warn"}
        />
        <Metric
          icon={<Rows3 className="h-4 w-4" aria-hidden="true" />}
          label="活跃会话"
          value={String(health?.sessions.active ?? "-")}
          tone="idle"
        />
        <Metric
          icon={<Clock3 className="h-4 w-4" aria-hidden="true" />}
          label="运行时长"
          value={health ? formatUptime(health.uptimeSeconds) : "-"}
          tone="idle"
        />
      </div>

      <Card className="mt-5 overflow-hidden">
        <CardHeader className="border-b border-line/80 bg-white">
          <div className="flex items-center justify-between gap-4">
            <CardTitle className="inline-flex items-center gap-2">
              <Activity className="h-4 w-4 text-teal" aria-hidden="true" />
              队列与连接
            </CardTitle>
            <div className="h-2 w-28 rounded-full bg-gradient-to-r from-modelblue via-teal to-brass" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid overflow-hidden rounded-panel border-l border-t border-line bg-white md:grid-cols-3">
            <Detail label="Graphiti pending" value={String(health?.queues.graphiti.pending ?? "-")} />
            <Detail label="Graphiti running" value={String(health?.queues.graphiti.running ?? "-")} />
            <Detail label="SSE reconnects" value={String(health?.sse.reconnectCount ?? "-")} />
            <Detail label="Last ready" value={formatDate(health?.sse.lastReadyAt)} />
            <Detail label="Last message" value={formatDate(health?.sse.lastMessageAt)} />
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}

function HeaderDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-line/70 px-3 py-3 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <div className="text-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

const metricValueClass: Record<"good" | "warn" | "idle", string> = {
  good: "text-teal",
  warn: "text-rust",
  idle: "text-ink",
};

const metricAccentClass: Record<"good" | "warn" | "idle", string> = {
  good: "bg-teal",
  warn: "bg-rust",
  idle: "bg-brass",
};

const metricIconClass: Record<"good" | "warn" | "idle", string> = {
  good: "bg-teal/10 text-teal",
  warn: "bg-rust/10 text-rust",
  idle: "bg-violetsoft text-brass",
};

function Metric({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "good" | "warn" | "idle";
}) {
  return (
    <Card className="group overflow-hidden bg-white transition duration-200 hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-modelblue/10">
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-muted">
            <span className={`grid h-9 w-9 place-items-center rounded-panel ${metricIconClass[tone]}`}>
              {icon}
            </span>
            <span className="text-xs uppercase tracking-[0.16em]">{label}</span>
          </div>
          <div className={`h-2 w-2 rounded-full ${metricAccentClass[tone]}`} />
        </div>
        <div className={`font-mono text-2xl font-semibold ${metricValueClass[tone]}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-r border-line px-3 py-2">
      <div className="text-xs uppercase text-muted">{label}</div>
      <div className="mt-1 break-words font-mono text-sm text-ink">{value}</div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
  });
}

