import { runMigrations } from "./migrate";

runMigrations()
  .then(() => {
    console.info(JSON.stringify({ level: "info", module: "db", msg: "migrations applied" }));
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(JSON.stringify({ level: "error", module: "db", msg: "migration failed", err }));
    process.exit(1);
  });
