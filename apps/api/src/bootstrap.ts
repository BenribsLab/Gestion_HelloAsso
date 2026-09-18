import { loadConfig } from "./config.js";
import { runMigrations } from "./migrations.js";

await runMigrations(loadConfig());
await import("./server.js");
