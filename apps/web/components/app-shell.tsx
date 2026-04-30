import { Activity, LogOut, PlugZap } from "lucide-react";
import Link from "next/link";
import { logoutAction } from "../app/actions";

const navItems = [
  {
    href: "/",
    label: "运行状态",
    id: "dashboard",
    icon: Activity,
  },
  {
    href: "/plugins",
    label: "插件",
    id: "plugins",
    icon: PlugZap,
  },
];

export function AppShell({
  active,
  children,
}: {
  active: "dashboard" | "plugins";
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl border-x border-line/80 bg-panel/72">
        <aside className="hidden w-64 shrink-0 border-r border-line/80 bg-[#f6f8f1]/82 px-4 py-5 md:block">
          <div className="mb-8">
            <div className="text-xs uppercase tracking-[0.18em] text-muted">Agent Gateway</div>
            <div className="mt-2 text-xl font-semibold text-ink">控制台</div>
          </div>

          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = active === item.id;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex h-10 items-center gap-2 rounded-panel px-3 text-sm font-medium transition ${
                    isActive
                      ? "bg-ink text-white"
                      : "text-muted hover:bg-white hover:text-ink hover:shadow-hairline"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <form action={logoutAction} className="mt-8">
            <button
              type="submit"
              className="flex h-10 w-full items-center gap-2 rounded-panel px-3 text-sm font-medium text-muted transition hover:bg-white hover:text-rust hover:shadow-hairline"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              退出登录
            </button>
          </form>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-h-16 items-center justify-between border-b border-line/80 bg-panel/82 px-4 md:px-7">
            <div className="md:hidden">
              <div className="text-sm font-semibold">Agent Gateway</div>
              <div className="text-xs text-muted">控制台</div>
            </div>
            <nav className="flex gap-2 md:hidden">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = active === item.id;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-label={item.label}
                    className={`grid h-9 w-9 place-items-center rounded-panel border ${
                      isActive ? "border-ink bg-ink text-white" : "border-line bg-white text-muted"
                    }`}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </Link>
                );
              })}
            </nav>
            <form action={logoutAction} className="hidden md:block">
              <button
                type="submit"
                className="inline-flex h-9 items-center gap-2 rounded-panel border border-line bg-white px-3 text-sm font-medium text-muted transition hover:border-rust hover:text-rust"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                退出
              </button>
            </form>
          </header>

          <div className="flex-1 px-4 py-6 md:px-7 md:py-7">{children}</div>
        </main>
      </div>
    </div>
  );
}

