import { runMigrations } from "./migrate";

runMigrations()
  .then(() => {
    console.info(
      JSON.stringify({ level: "info", module: "db:migrate", msg: "migrations applied" }),
    );
  })
  .catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        module: "db:migrate",
        msg: "migration failed",
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  });
