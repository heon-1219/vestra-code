import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit reads `.env`, not `.env.local`, which is where Next.js keeps
// local secrets. Load it explicitly so one file holds the truth.
config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
