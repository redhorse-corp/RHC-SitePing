import { createSitepingMcpHandler } from "@siteping/adapter-prisma/mcp";
import { memoryStore } from "./memory-store";
import { sitepingMcpOptionsFromEnv } from "./siteping-mcp-config";

const options = sitepingMcpOptionsFromEnv();
const handler = options ? createSitepingMcpHandler({ ...options, store: memoryStore }) : null;

export async function sitepingMcpFetch(request: Request): Promise<Response> {
  if (!handler) return new Response("Not Found", { status: 404 });
  return handler.fetch(request);
}
