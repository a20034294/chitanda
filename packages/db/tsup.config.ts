import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/migrate.ts", "src/schema.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true
});
