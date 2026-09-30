import { sitepingMcpFetch } from "@/lib/siteping-mcp";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return sitepingMcpFetch(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return sitepingMcpFetch(request);
}
