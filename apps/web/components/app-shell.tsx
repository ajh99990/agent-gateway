import { Activity, Boxes, ChevronRight, LogOut, PlugZap, Sparkles } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
      <header className="sticky top-0 z-30 border-b border-line/80 bg-white/86 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 md:px-6">
          <Link href="/" className="flex items-center gap-3">
            <div className="platform-gradient grid h-10 w-10 place-items-center rounded-panel text-white shadow-lg shadow-modelblue/20">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-sm font-semibold text-ink">Agent Gateway</div>
              <div className="text-xs text-muted">AI Agent Console</div>
            </div>
          </Link>

          <nav className="hidden items-center gap-1 rounded-full border border-line bg-surface p-1 md:flex">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = active === item.id;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium transition",
                    isActive
                      ? "bg-white text-modelblue shadow-sm shadow-modelblue/10"
                      : "text-muted hover:bg-white/70 hover:text-ink",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-xs text-muted lg:flex">
              <Boxes className="h-3.5 w-3.5 text-teal" aria-hidden="true" />
              Admin API
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </div>
            <form action={logoutAction}>
              <Button className="h-9" type="submit" variant="outline">
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">退出</span>
              </Button>
            </form>
          </div>
        </div>
        <nav className="mx-auto flex h-12 w-full max-w-7xl items-center gap-2 overflow-x-auto border-t border-line/70 px-4 md:hidden">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.id;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-sm font-medium",
                  isActive ? "bg-modelblue text-white" : "bg-white text-muted",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto min-h-[calc(100vh-4rem)] w-full max-w-7xl px-4 py-6 md:px-6 md:py-8">
        {children}
      </main>
    </div>
  );
}
