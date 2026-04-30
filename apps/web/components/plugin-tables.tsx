import { Power, PowerOff, Tag } from "lucide-react";
import { setPluginStateAction } from "../app/actions";
import type { PluginDescriptor, SessionPluginState } from "../lib/gateway-client";
import { StatusPill } from "./status-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function RegisteredPluginsTable({ plugins }: { plugins: PluginDescriptor[] }) {
  if (plugins.length === 0) {
    return <EmptyState>暂无插件</EmptyState>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {plugins.map((plugin) => (
        <Card key={plugin.id} className="group bg-white transition duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-modelblue/10">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-ink">{plugin.name}</div>
                <div className="mt-1 truncate font-mono text-xs text-muted">{plugin.id}</div>
              </div>
              <StatusPill tone={plugin.system ? "idle" : "good"}>
                {plugin.system ? "系统" : "业务"}
              </StatusPill>
            </div>

            <div className="mt-5 flex flex-wrap gap-1.5">
              {plugin.keywords.length > 0 ? (
                plugin.keywords.map((keyword) => (
                  <Badge key={keyword} className="border-line bg-surface font-mono text-xs text-muted" variant="outline">
                    <Tag className="h-3 w-3" aria-hidden="true" />
                    {keyword}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted">暂无关键词</span>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function SessionPluginsTable({
  plugins,
  sessionId,
}: {
  plugins: SessionPluginState[];
  sessionId: string;
}) {
  if (plugins.length === 0) {
    return <EmptyState>当前群暂无插件状态</EmptyState>;
  }

  return (
    <div className="grid gap-4">
      {plugins.map((plugin) => (
        <Card key={plugin.id} className="bg-white transition duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-modelblue/10">
          <CardContent className="p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{plugin.name}</span>
                  <StatusPill tone={plugin.enabled ? "good" : "warn"}>
                    {plugin.enabled ? "已开启" : "已关闭"}
                  </StatusPill>
                  {plugin.system ? <StatusPill tone="idle">系统</StatusPill> : null}
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted">{plugin.id}</div>
              </div>

              <div className="flex flex-wrap gap-2">
                <PluginButton sessionId={sessionId} plugin={plugin} enabled={true} />
                <PluginButton sessionId={sessionId} plugin={plugin} enabled={false} />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-panel border border-dashed border-line bg-white px-4 py-12 text-center text-sm text-muted">
      {children}
    </div>
  );
}

function PluginButton({
  sessionId,
  plugin,
  enabled,
}: {
  sessionId: string;
  plugin: SessionPluginState;
  enabled: boolean;
}) {
  const Icon = enabled ? Power : PowerOff;
  const disabled = !plugin.manageable || plugin.enabled === enabled;

  return (
    <form action={setPluginStateAction}>
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="pluginId" value={plugin.id} />
      <input type="hidden" name="enabled" value={String(enabled)} />
      <Button disabled={disabled} size="sm" type="submit" variant={enabled ? "secondary" : "outline"}>
        <Icon className="h-4 w-4" aria-hidden="true" />
        {enabled ? "开启" : "关闭"}
      </Button>
    </form>
  );
}
