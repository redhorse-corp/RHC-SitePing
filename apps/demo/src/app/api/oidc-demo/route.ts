import { MemoryStore } from "@siteping/adapter-memory";
import { createSitepingHandler, type SitepingHandler } from "@siteping/adapter-prisma";
import { OIDC_DEMO } from "@/lib/oidc-demo-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const store = new MemoryStore();
let handler: SitepingHandler | undefined;

function getHandler(): SitepingHandler | null {
  if (process.env.NODE_ENV !== "development") return null;
  if (!handler) {
    handler = createSitepingHandler({
      store,
      oidc: {
        issuer: OIDC_DEMO.issuer,
        audience: OIDC_DEMO.audience,
        jwksUri: OIDC_DEMO.jwksUri,
        rolesClaim: "groups",
        adminRoles: ["project-alpha"],
        allowOwnerDeletes: false,
      },
    });
  }
  return handler;
}

function dispatch(method: "GET" | "POST" | "PATCH" | "DELETE") {
  return async (request: Request): Promise<Response> => {
    const api = getHandler();
    return api ? api[method](request) : Response.json({ error: "Not found" }, { status: 404 });
  };
}

export const GET = dispatch("GET");
export const POST = dispatch("POST");
export const PATCH = dispatch("PATCH");
export const DELETE = dispatch("DELETE");
