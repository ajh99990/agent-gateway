"use server";

import { redirect } from "next/navigation";
import { clearSession, createSession, requireSession } from "../lib/auth";
import { getRequiredEnv } from "../lib/env";
import { setSessionPluginEnabled } from "../lib/gateway-client";
import { verifyPassword } from "../lib/password";

export async function loginAction(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const storedHash = getRequiredEnv("WEB_ADMIN_PASSWORD_HASH");
  const ok = await verifyPassword(password, storedHash);
  if (!ok) {
    redirect("/login?error=invalid");
  }

  await createSession();
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect("/login");
}

export async function setPluginStateAction(formData: FormData): Promise<void> {
  await requireSession();

  const sessionId = String(formData.get("sessionId") ?? "").trim();
  const pluginId = String(formData.get("pluginId") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "true";

  if (!sessionId || !pluginId) {
    redirect("/plugins?error=missing-input");
  }

  const result = await setSessionPluginEnabled(sessionId, pluginId, enabled);
  if (result.error) {
    redirect(`/plugins?sessionId=${encodeURIComponent(sessionId)}&error=${encodeURIComponent(result.error)}`);
  }

  redirect(`/plugins?sessionId=${encodeURIComponent(sessionId)}&updated=${encodeURIComponent(pluginId)}`);
}

