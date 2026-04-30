import { CircleAlert, Compass, PlugZap, Search as SearchIcon, Sparkles } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AppShell } from "../../components/app-shell";
import { RegisteredPluginsTable, SessionPluginsTable } from "../../components/plugin-tables";
import { StatusPill } from "../../components/status-pill";
import { getPlugins, getSessionPlugins } from "../../lib/gateway-client";
import { requireSession } from "../../lib/auth";

export default async function PluginsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const params = (await searchParams) ?? {};
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  const error = typeof params.error === "string" ? params.error : undefined;

  const pluginsResult = await getPlugins();
  const sessionResult = sessionId ? await getSessionPlugins(sessionId) : undefined;
  const plugins = pluginsResult.data?.plugins ?? [];

  return (
    <AppShell active="plugins">
      <section className="mb-6 overflow-hidden rounded-panel border border-line bg-white shadow-xl shadow-modelblue/5">
        <div className="mesh-band p-5 md:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-modelblue shadow-sm">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Plugin Hub
              </div>
              <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-tight text-ink md:text-5xl">
                插件资源中心
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted md:text-base">
                像浏览模型资源一样管理 Agent 能力，按群加载、启用或关闭插件能力。
              </p>
            </div>
            <StatusPill tone={pluginsResult.data ? "good" : "warn"}>
              {pluginsResult.data ? "Admin API 已连接" : "Admin API 异常"}
            </StatusPill>
          </div>
        </div>
        <div className="grid border-t border-line bg-white px-5 py-4 text-xs md:grid-cols-3">
          <HeaderDatum label="Registered" value={String(plugins.length)} />
          <HeaderDatum label="Session" value={sessionId || "未选择"} />
          <HeaderDatum
            label="Loaded"
            value={sessionResult?.data ? String(sessionResult.data.plugins.length) : "-"}
          />
        </div>
      </section>

      {pluginsResult.error || error ? (
        <Alert className="mb-5" variant="destructive">
          <CircleAlert className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{pluginsResult.error ?? error}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="mb-5 overflow-hidden bg-white">
        <CardHeader className="border-b border-line/80 bg-white">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <CardTitle className="inline-flex items-center gap-2">
              <SearchIcon className="h-4 w-4 text-teal" aria-hidden="true" />
              选择群会话
            </CardTitle>
            <div className="font-mono text-xs text-muted">sessionId</div>
          </div>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3 md:flex-row" action="/plugins">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input
                className="font-mono pl-9"
                name="sessionId"
                defaultValue={sessionId}
                placeholder="56594698995@chatroom"
              />
            </div>
            <Button type="submit">
              <SearchIcon className="h-4 w-4" aria-hidden="true" />
              查看
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <Card className="overflow-hidden bg-white">
          <CardHeader className="border-b border-line/80 bg-white">
            <CardTitle className="inline-flex items-center gap-2">
              <Compass className="h-4 w-4 text-modelblue" aria-hidden="true" />
              插件广场
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RegisteredPluginsTable plugins={plugins} />
          </CardContent>
        </Card>

        <Card className="overflow-hidden bg-white">
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 border-b border-line/80 bg-white">
            <div>
              <CardTitle className="inline-flex items-center gap-2">
                <PlugZap className="h-4 w-4 text-brass" aria-hidden="true" />
                当前群插件状态
              </CardTitle>
              <div className="mt-1 font-mono text-xs font-normal text-muted">
                {sessionId || "未选择 sessionId"}
              </div>
            </div>
            {sessionResult?.data ? (
              <StatusPill tone="good">已加载</StatusPill>
            ) : (
              <StatusPill tone="idle">等待选择</StatusPill>
            )}
          </CardHeader>
          <CardContent>
            {sessionResult?.error ? (
              <Alert className="mb-4" variant="destructive">
                <CircleAlert className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{sessionResult.error}</AlertDescription>
              </Alert>
            ) : null}

            {sessionResult?.data ? (
              <SessionPluginsTable plugins={sessionResult.data.plugins} sessionId={sessionId} />
            ) : (
              <div className="rounded-panel border border-dashed border-line bg-surface px-4 py-12 text-center text-sm text-muted">
                输入群 sessionId 后查看按群启停状态
              </div>
            )}
          </CardContent>
        </Card>
      </div>
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
