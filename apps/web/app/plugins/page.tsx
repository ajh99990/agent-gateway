import { PlugZap, Power, PowerOff, Search } from "lucide-react";
import { setPluginStateAction } from "../actions";
import { AppShell } from "../../components/app-shell";
import { StatusPill } from "../../components/status-pill";
import { getPlugins, getSessionPlugins, type SessionPluginState } from "../../lib/gateway-client";
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

  return (
    <AppShell active="plugins">
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-muted">Plugins</div>
          <h1 className="mt-2 text-3xl font-semibold text-ink">插件管理</h1>
        </div>
        <StatusPill tone={pluginsResult.data ? "good" : "warn"}>
          {pluginsResult.data ? "Admin API 已连接" : "Admin API 异常"}
        </StatusPill>
      </div>

      {pluginsResult.error || error ? (
        <div className="mb-5 rounded-panel border border-rust/25 bg-rust/10 px-4 py-3 text-sm text-rust">
          {pluginsResult.error ?? error}
        </div>
      ) : null}

      <section className="mb-5 border border-line bg-panel p-4 shadow-hairline">
        <div className="mb-4 flex items-center gap-2">
          <Search className="h-4 w-4 text-teal" aria-hidden="true" />
          <h2 className="text-base font-semibold text-ink">选择群会话</h2>
        </div>
        <form className="flex flex-col gap-3 md:flex-row" action="/plugins">
          <input
            name="sessionId"
            defaultValue={sessionId}
            placeholder="56594698995@chatroom"
            className="h-10 min-w-0 flex-1 rounded-panel border border-line bg-white px-3 font-mono text-sm text-ink outline-none transition focus:border-teal focus:ring-2 focus:ring-teal/15"
          />
          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-panel bg-ink px-4 text-sm font-semibold text-white transition hover:bg-teal"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            查看
          </button>
        </form>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <section className="border border-line bg-panel p-4 shadow-hairline">
          <div className="mb-4 flex items-center gap-2">
            <PlugZap className="h-4 w-4 text-brass" aria-hidden="true" />
            <h2 className="text-base font-semibold text-ink">已注册插件</h2>
          </div>
          <div className="divide-y divide-line border border-line bg-white">
            {(pluginsResult.data?.plugins ?? []).map((plugin) => (
              <div key={plugin.id} className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-ink">{plugin.name}</div>
                    <div className="mt-1 font-mono text-xs text-muted">{plugin.id}</div>
                  </div>
                  <StatusPill tone={plugin.system ? "idle" : "good"}>
                    {plugin.system ? "系统" : "业务"}
                  </StatusPill>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {plugin.keywords.map((keyword) => (
                    <span
                      key={keyword}
                      className="rounded-full border border-line bg-[#f7f8f2] px-2 py-0.5 text-xs text-muted"
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border border-line bg-panel p-4 shadow-hairline">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-ink">当前群插件状态</h2>
              <div className="mt-1 font-mono text-xs text-muted">{sessionId || "未选择 sessionId"}</div>
            </div>
            {sessionResult?.data ? <StatusPill tone="good">已加载</StatusPill> : <StatusPill tone="idle">等待选择</StatusPill>}
          </div>

          {sessionResult?.error ? (
            <div className="mb-4 rounded-panel border border-rust/25 bg-rust/10 px-4 py-3 text-sm text-rust">
              {sessionResult.error}
            </div>
          ) : null}

          {sessionResult?.data ? (
            <div className="divide-y divide-line border border-line bg-white">
              {sessionResult.data.plugins.map((plugin) => (
                <SessionPluginRow key={plugin.id} sessionId={sessionId} plugin={plugin} />
              ))}
            </div>
          ) : (
            <div className="border border-dashed border-line bg-white px-4 py-10 text-center text-sm text-muted">
              输入群 sessionId 后查看按群启停状态。
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function SessionPluginRow({
  sessionId,
  plugin,
}: {
  sessionId: string;
  plugin: SessionPluginState;
}) {
  return (
    <div className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-medium text-ink">{plugin.name}</span>
          <StatusPill tone={plugin.enabled ? "good" : "warn"}>{plugin.enabled ? "已开启" : "已关闭"}</StatusPill>
          {plugin.system ? <StatusPill tone="idle">系统</StatusPill> : null}
        </div>
        <div className="mt-1 font-mono text-xs text-muted">{plugin.id}</div>
      </div>

      <div className="flex gap-2">
        <PluginButton sessionId={sessionId} plugin={plugin} enabled={true} />
        <PluginButton sessionId={sessionId} plugin={plugin} enabled={false} />
      </div>
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
      <button
        type="submit"
        disabled={disabled}
        className="inline-flex h-9 items-center gap-2 rounded-panel border border-line bg-white px-3 text-sm font-medium text-ink transition hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        {enabled ? "开启" : "关闭"}
      </button>
    </form>
  );
}
