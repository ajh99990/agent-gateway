import { Activity, Clock3, Database, Radio, Rows3 } from "lucide-react";
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
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-muted">Gateway</div>
          <h1 className="mt-2 text-3xl font-semibold text-ink">运行状态</h1>
        </div>
        {health ? (
          <StatusPill tone="good">服务在线</StatusPill>
        ) : (
          <StatusPill tone="warn">无法连接</StatusPill>
        )}
      </div>

      {result.error ? (
        <div className="mb-5 rounded-panel border border-rust/25 bg-rust/10 px-4 py-3 text-sm text-rust">
          {result.error}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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

      <section className="mt-5 border border-line bg-panel p-4 shadow-hairline">
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4 text-teal" aria-hidden="true" />
          <h2 className="text-base font-semibold text-ink">队列与连接</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Detail label="Graphiti pending" value={String(health?.queues.graphiti.pending ?? "-")} />
          <Detail label="Graphiti running" value={String(health?.queues.graphiti.running ?? "-")} />
          <Detail label="SSE reconnects" value={String(health?.sse.reconnectCount ?? "-")} />
          <Detail label="Last ready" value={formatDate(health?.sse.lastReadyAt)} />
          <Detail label="Last message" value={formatDate(health?.sse.lastMessageAt)} />
        </div>
      </section>
    </AppShell>
  );
}

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
  const toneClass = tone === "good" ? "text-teal" : tone === "warn" ? "text-rust" : "text-ink";
  return (
    <div className="border border-line bg-panel p-4 shadow-hairline">
      <div className="mb-3 flex items-center gap-2 text-muted">
        {icon}
        <span className="text-xs uppercase tracking-[0.16em]">{label}</span>
      </div>
      <div className={`font-mono text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-white px-3 py-2">
      <div className="text-xs uppercase tracking-[0.14em] text-muted">{label}</div>
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

