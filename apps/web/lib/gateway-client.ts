import { getRequiredEnv } from "./env";

export interface HealthSnapshot {
  status: "ok";
  uptimeSeconds: number;
  redis: "ok" | "error";
  sse: {
    connected: boolean;
    lastReadyAt?: string;
    lastMessageAt?: string;
    reconnectCount: number;
  };
  sessions: {
    active: number;
  };
  queues: {
    graphiti: {
      pending: number;
      running: number;
    };
  };
}

export interface PluginDescriptor {
  id: string;
  name: string;
  keywords: string[];
  system: boolean;
}

export interface SessionPluginState extends PluginDescriptor {
  enabled: boolean;
  manageable: boolean;
}

export interface GatewayResult<T> {
  data?: T;
  error?: string;
}

export async function getHealth(): Promise<GatewayResult<HealthSnapshot>> {
  return gatewayFetch<HealthSnapshot>("/health", { auth: false });
}

export async function getPlugins(): Promise<GatewayResult<{ plugins: PluginDescriptor[] }>> {
  return gatewayFetch<{ plugins: PluginDescriptor[] }>("/admin/plugins", { auth: true });
}

export async function getSessionPlugins(
  sessionId: string,
): Promise<GatewayResult<{ sessionId: string; plugins: SessionPluginState[] }>> {
  return gatewayFetch<{ sessionId: string; plugins: SessionPluginState[] }>(
    `/admin/sessions/${encodeURIComponent(sessionId)}/plugins`,
    { auth: true },
  );
}

export async function setSessionPluginEnabled(
  sessionId: string,
  pluginId: string,
  enabled: boolean,
): Promise<GatewayResult<{ sessionId: string; plugin: SessionPluginState }>> {
  const action = enabled ? "enable" : "disable";
  return gatewayFetch<{ sessionId: string; plugin: SessionPluginState }>(
    `/admin/sessions/${encodeURIComponent(sessionId)}/plugins/${encodeURIComponent(pluginId)}/${action}`,
    {
      auth: true,
      init: {
        method: "POST",
      },
    },
  );
}

async function gatewayFetch<T>(
  path: string,
  options: {
    auth: boolean;
    init?: RequestInit;
  },
): Promise<GatewayResult<T>> {
  try {
    const baseUrl = getRequiredEnv("GATEWAY_ADMIN_BASE_URL").replace(/\/+$/, "");
    const headers = new Headers(options.init?.headers);
    if (options.auth) {
      headers.set("Authorization", `Bearer ${getRequiredEnv("GATEWAY_ADMIN_TOKEN")}`);
    }

    const response = await fetch(`${baseUrl}${path}`, {
      ...options.init,
      headers,
      cache: "no-store",
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};

    if (!response.ok) {
      return {
        error: extractError(payload) ?? `Gateway request failed: ${response.status}`,
      };
    }

    return {
      data: payload as T,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Gateway request failed",
    };
  }
}

function extractError(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }

  return undefined;
}

