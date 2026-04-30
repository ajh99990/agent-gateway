import { hashPassword } from "../lib/password";

async function main(): Promise<void> {
  const password = process.argv[2];
  if (!password) {
    console.error("Usage: pnpm web:hash-password -- <password>");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  console.log(`WEB_ADMIN_PASSWORD_HASH=${hash}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

