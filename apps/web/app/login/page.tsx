import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { hasSession } from "../../lib/auth";

const errorText: Record<string, string> = {
  invalid: "密码不正确。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await hasSession()) {
    redirect("/");
  }

  const params = (await searchParams) ?? {};
  const error = typeof params.error === "string" ? errorText[params.error] : undefined;

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-[22px] border border-line bg-panel/80 shadow-2xl shadow-ink/15 md:grid-cols-[0.9fr_1.1fr]">
        <section className="rail-sheen hidden min-h-[520px] flex-col justify-between p-8 text-white md:flex">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-xs uppercase tracking-[0.18em] text-white/65">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Secure Console
            </div>
            <h1 className="mt-8 text-4xl font-semibold leading-tight tracking-normal">
              Agent Gateway
              <span className="block text-white/58">Command Surface</span>
            </h1>
          </div>
          <div className="grid gap-3 text-sm">
            <div className="rounded-panel border border-white/10 bg-black/10 p-4">
              <div className="text-white/45">Session</div>
              <div className="mt-1 font-mono text-white/85">HTTP_ONLY_COOKIE</div>
            </div>
            <div className="rounded-panel border border-white/10 bg-black/10 p-4">
              <div className="text-white/45">Scope</div>
              <div className="mt-1 font-mono text-white/85">ADMIN_API</div>
            </div>
          </div>
        </section>

        <section className="bg-panel/95 p-5 md:p-8">
          <Card className="h-full border-line/80 bg-white/70 shadow-none">
            <CardContent className="flex h-full flex-col justify-center p-5 md:p-8">
              <div className="mb-8 flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-teal">Agent Gateway</div>
                  <h2 className="mt-2 text-3xl font-semibold text-ink">控制台登录</h2>
                  <p className="mt-2 text-sm text-muted">输入管理员密码进入运行面板。</p>
                </div>
                <div className="grid h-11 w-11 place-items-center rounded-panel border border-line bg-white text-teal shadow-sm">
                  <LockKeyhole className="h-5 w-5" aria-hidden="true" />
                </div>
              </div>

              <form action="/api/login" className="space-y-4" method="post">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-ink">管理员密码</span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                    <Input
                      className="h-11 pl-9"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </div>
                </label>

                {error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                <Button className="h-11 w-full" type="submit">
                  登录
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}

