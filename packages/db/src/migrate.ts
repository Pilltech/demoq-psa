import { runMigrations } from "./migrator";

const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) {
  console.error("MIGRATOR_DATABASE_URL is not set (see .env.example). The app role must never run migrations.");
  process.exit(1);
}
runMigrations(url, (l) => console.log(l))
  .then((r) => console.log(`migrations: ${r.applied.length} applied, ${r.skipped.length} already applied`))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
