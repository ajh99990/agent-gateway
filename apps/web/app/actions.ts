"use server";

import { redirect } from "next/navigation";
import { clearSession, requireSession } from "../lib/auth";
import { setSessionPluginEnabled } from "../lib/gateway-client";

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

