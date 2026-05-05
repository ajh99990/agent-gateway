import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import pg from "pg";
import type { AppConfig } from "../config.js";
import * as schema from "./schema/index.js";

const { Pool } = pg;

export type GatewayDatabase = NodePgDatabase<typeof schema>;
export type GatewayTransaction = Parameters<Parameters<GatewayDatabase["transaction"]>[0]>[0];

export class PostgresStore {
  private readonly pool: pg.Pool;
  public readonly db: GatewayDatabase;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.pool = new Pool({
      connectionString: this.config.databaseUrl,
    });

    this.pool.on("error", (error: unknown) => {
      this.logger.error({ err: error }, "PostgreSQL 连接池出现异常");
    });

    this.db = drizzle(this.pool, {
      schema,
    });
  }

  public async ping(): Promise<void> {
    await this.pool.query("select 1");
  }

  public async disconnect(): Promise<void> {
    await this.pool.end();
  }
}
