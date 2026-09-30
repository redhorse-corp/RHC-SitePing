import { defineConfig } from "tsup";
import { sitepingLibrary } from "../../tsup.preset.js";

export default defineConfig(
  sitepingLibrary({
    entry: ["src/index.ts", "src/mcp.ts"],
    platform: "node",
    target: "node18",
    external: ["@modelcontextprotocol/server", "@prisma/client"],
  }),
);
