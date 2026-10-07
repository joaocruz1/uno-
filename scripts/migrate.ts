import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb } from "../src/db";

async function main(): Promise<void> {
  try {
    await migrate(getDb(), { migrationsFolder: "./drizzle" });
    console.info("Database migrations completed.");
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
});
