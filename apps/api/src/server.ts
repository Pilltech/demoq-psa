import { createDb } from "@demoq/db";
import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const { db } = createDb(config.DATABASE_URL);
const app = await buildApp({ db, clock: () => new Date() }, config);

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
