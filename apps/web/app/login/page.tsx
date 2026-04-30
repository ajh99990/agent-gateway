import { LockKeyhole } from "lucide-react";
import { redirect } from "next/navigation";
import { loginAction } from "../actions";
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
      <section className="w-full max-w-sm border border-line bg-panel p-5 shadow-hairline">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-muted">Agent Gateway</div>
            <h1 className="mt-2 text-2xl font-semibold text-ink">控制台登录</h1>
          </div>
          <div className="grid h-10 w-10 place-items-center rounded-panel border border-line bg-white text-teal">
            <LockKeyhole className="h-5 w-5" aria-hidden="true" />
          </div>
        </div>

        <form action={loginAction} className="space-y-4">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-ink">管理员密码</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              className="h-11 w-full rounded-panel border border-line bg-white px-3 text-sm text-ink outline-none transition focus:border-teal focus:ring-2 focus:ring-teal/15"
              required
            />
          </label>

          {error ? (
            <div className="rounded-panel border border-rust/25 bg-rust/10 px-3 py-2 text-sm text-rust">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            className="h-11 w-full rounded-panel bg-ink px-4 text-sm font-semibold text-white transition hover:bg-teal"
          >
            登录
          </button>
        </form>
      </section>
    </main>
  );
}

