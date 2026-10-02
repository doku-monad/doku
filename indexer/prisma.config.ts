import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 moved the connection URL out of `schema.prisma`, which is the right shape for this
 * service: the *runtime* never reads a URL from here at all. It connects through a driver adapter
 * chosen at boot — `@prisma/adapter-pg` against a pooled Postgres in a deployment, and PGlite
 * in-process for tests and local development. What is left here is only what the CLI needs to run
 * migrations and introspection against a real database.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // `process.env` rather than Prisma's `env()` helper, which throws when the variable is unset.
  // It legitimately is unset most of the time: the runtime uses a driver adapter and never reads
  // this, and `prisma generate` needs no database at all. Only `migrate` and `db pull` do.
  datasource: { url: process.env.DATABASE_URL },
});
