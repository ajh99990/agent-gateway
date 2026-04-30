import { NextResponse } from "next/server";
import { createSession } from "../../../lib/auth";
import { getRequiredEnv } from "../../../lib/env";
import { verifyPassword } from "../../../lib/password";

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const password = String(formData.get("password") ?? "");
  const storedHash = getRequiredEnv("WEB_ADMIN_PASSWORD_HASH");
  const ok = await verifyPassword(password, storedHash);

  if (!ok) {
    return NextResponse.redirect(new URL("/login?error=invalid", request.url), {
      status: 303,
    });
  }

  await createSession();
  return NextResponse.redirect(new URL("/", request.url), {
    status: 303,
  });
}
