import { isIP } from "node:net";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  McpServer,
} from "@modelcontextprotocol/server";
import {
  DEFAULT_PAGE_LIMIT,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  type FeedbackRecord,
  type FeedbackStatus,
  type FeedbackType,
  MAX_PAGE_LIMIT,
  type SitepingStore,
  toFeedbackUpdate,
} from "@siteping/core";
import { z } from "zod";
import type { OidcOptions, OidcPrincipal } from "./oidc.js";
import { createOidcVerifier, OidcInvalidTokenError, OidcUnavailableError } from "./oidc.js";

export interface SitepingMcpOptions {
  store: SitepingStore;
  projectName: string;
  resourceUrl: URL;
  oidc: Pick<OidcOptions, "issuer" | "jwksUri" | "rolesClaim" | "adminRoles">;
  allowedOrigins?: readonly string[];
}

export interface SitepingMcpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  readonly protectedResourceMetadataPath: string;
}

type FeedbackProjection = Pick<FeedbackRecord, "id" | "type" | "message" | "status" | "url" | "urlPattern"> & {
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

type FeedbackFilters = {
  page: number;
  limit: number;
  type?: FeedbackType | undefined;
  status?: FeedbackStatus | undefined;
  url?: string | undefined;
  urlPattern?: string | undefined;
};

const feedbackFiltersSchema = {
  page: z.number().int().min(1).max(1_000_000).default(1),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  type: z.enum(FEEDBACK_TYPES).optional(),
  status: z.enum(FEEDBACK_STATUSES).optional(),
  url: z.string().min(1).max(2048).optional(),
  urlPattern: z.string().min(1).max(2048).optional(),
};

const listFeedbackInput = z.object(feedbackFiltersSchema).strict();
const searchFeedbackInput = z
  .object({
    ...feedbackFiltersSchema,
    query: z.string().trim().min(1).max(500),
  })
  .strict();
const changeStatusInput = z
  .object({
    feedbackId: z.string().trim().min(1).max(256),
    status: z.enum(FEEDBACK_STATUSES),
  })
  .strict();

function validateResourceUrl(resourceUrl: URL): void {
  const host = resourceUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  const localDevelopmentHttp = process.env.NODE_ENV === "development" && resourceUrl.protocol === "http:" && isLoopback;
  if (resourceUrl.protocol !== "https:" && !localDevelopmentHttp) {
    throw new TypeError("[siteping] MCP resourceUrl must use HTTPS (loopback HTTP is allowed in development).");
  }
  const href = resourceUrl.href;
  if (resourceUrl.username || resourceUrl.password || href.includes("?") || href.includes("#")) {
    throw new TypeError("[siteping] MCP resourceUrl must not contain credentials, a query, or a fragment.");
  }
}

function parseAllowedOrigins(origins: readonly string[] | undefined): Set<string> {
  const allowedOrigins = new Set<string>();
  for (const origin of origins ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch (cause) {
      throw new TypeError("[siteping] MCP allowedOrigins must contain absolute origins.", { cause });
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new TypeError("[siteping] MCP allowedOrigins entries must be exact HTTP(S) origins, including ports.");
    }
    allowedOrigins.add(parsed.origin);
  }
  return allowedOrigins;
}

function projectFeedback(record: FeedbackRecord): FeedbackProjection {
  return {
    id: record.id,
    type: record.type,
    message: record.message,
    status: record.status,
    url: record.url,
    urlPattern: record.urlPattern,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
  };
}

function responseWithCors(response: Response, request: Request, allowedOrigins: ReadonlySet<string>): Response {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id");
  const vary = headers.get("Vary");
  if (!vary) {
    headers.set("Vary", "Origin");
  } else if (!vary.split(",").some((value) => value.trim().toLowerCase() === "origin")) {
    headers.set("Vary", `${vary}, Origin`);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(status: number, error: string, challenge?: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (challenge) headers.set("WWW-Authenticate", challenge);
  return Response.json({ error }, { status, headers });
}

function corsPreflight(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  methods = "GET, POST, DELETE, OPTIONS",
): Response {
  const headers = new Headers({
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Max-Age": "600",
  });
  const requestedHeaders = request.headers.get("access-control-request-headers");
  if (requestedHeaders) {
    const requested = requestedHeaders.split(",").map((header) => header.trim());
    if (requested.every((header) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header))) {
      headers.set("Access-Control-Allow-Headers", requested.join(", "));
    }
  }
  return responseWithCors(new Response(null, { status: 204, headers }), request, allowedOrigins);
}

export function createSitepingMcpHandler(options: SitepingMcpOptions): SitepingMcpHandler {
  const { store } = options;
  const resourceUrl = new URL(options.resourceUrl.href);
  const projectName = options.projectName.trim();
  if (!projectName) throw new TypeError("[siteping] MCP projectName must be non-empty.");
  validateResourceUrl(resourceUrl);

  const oidc = {
    ...options.oidc,
    ...(options.oidc.adminRoles === undefined ? {} : { adminRoles: [...options.oidc.adminRoles] }),
  };
  const verifier = createOidcVerifier({
    ...oidc,
    audience: resourceUrl.href,
  });
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const protectedResourceMetadataPath = new URL(metadataUrl).pathname;
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins);
  const allowedHostnames = [resourceUrl.hostname];
  const serverHandler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "siteping", version: "1.0.0" });

      const runSafely = async <T extends Record<string, unknown>>(action: () => Promise<T>) => {
        try {
          const value = await action();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value) ?? "null" }],
            structuredContent: value,
          };
        } catch {
          return {
            content: [{ type: "text" as const, text: "Unable to complete feedback request." }],
            isError: true,
          };
        }
      };

      const list = async (query: FeedbackFilters & { search?: string | undefined }) => {
        const result = await store.getFeedbacks({ ...query, projectName });
        if (result.feedbacks.some((record) => record.projectName !== projectName)) throw new Error();
        return {
          feedbacks: result.feedbacks.map(projectFeedback),
          total: result.total,
          page: query.page ?? 1,
          limit: query.limit ?? DEFAULT_PAGE_LIMIT,
        };
      };

      server.registerTool(
        "list_feedback",
        {
          description: "List this project's feedback with optional filters and bounded pagination.",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          inputSchema: listFeedbackInput,
        },
        (args) => runSafely(() => list(args)),
      );

      server.registerTool(
        "search_feedback",
        {
          description: "Search feedback messages in this project with optional filters and bounded pagination.",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          inputSchema: searchFeedbackInput,
        },
        ({ query, ...filters }) => runSafely(() => list({ ...filters, search: query })),
      );

      const verifyProjectOwnership = store.verifyProjectOwnership?.bind(store);
      if (verifyProjectOwnership) {
        server.registerTool(
          "change_feedback_status",
          {
            description: "Change a feedback status; closed statuses set resolvedAt and open statuses clear it.",
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
            inputSchema: changeStatusInput,
          },
          ({ feedbackId, status }) =>
            runSafely(async () => {
              if (!(await verifyProjectOwnership(feedbackId, projectName))) throw new Error();
              const updated = await store.updateFeedback(feedbackId, toFeedbackUpdate(status));
              if (updated.projectName !== projectName) throw new Error();
              return projectFeedback(updated);
            }),
        );
      }

      return server;
    },
    { legacy: "stateless" },
  );

  async function fetch(request: Request): Promise<Response> {
    const sdkHostRejection = hostHeaderValidationResponse(request, allowedHostnames);
    if (sdkHostRejection) return responseWithCors(sdkHostRejection, request, allowedOrigins);

    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return errorResponse(403, "forbidden");
    }
    const hostHeader = request.headers.get("host");
    if (!hostHeader || hostHeader.toLowerCase() !== resourceUrl.host.toLowerCase()) {
      return responseWithCors(errorResponse(403, "forbidden"), request, allowedOrigins);
    }

    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.has(origin)) {
      return errorResponse(403, "forbidden");
    }

    if (requestUrl.pathname === protectedResourceMetadataPath) {
      if (request.method === "OPTIONS") return corsPreflight(request, allowedOrigins, "GET, OPTIONS");
      if (request.method !== "GET") {
        return responseWithCors(
          new Response(null, { status: 405, headers: { Allow: "GET, OPTIONS" } }),
          request,
          allowedOrigins,
        );
      }
      return responseWithCors(
        Response.json(
          {
            resource: resourceUrl.href,
            authorization_servers: [oidc.issuer],
            bearer_methods_supported: ["header"],
          },
          { headers: { "Cache-Control": "public, max-age=300", Vary: "Origin" } },
        ),
        request,
        allowedOrigins,
      );
    }
    if (requestUrl.pathname !== resourceUrl.pathname) {
      return responseWithCors(new Response("Not Found", { status: 404 }), request, allowedOrigins);
    }
    if (request.method === "OPTIONS") return corsPreflight(request, allowedOrigins);

    const challenge = `Bearer resource_metadata="${metadataUrl}"`;
    const authorization = request.headers.get("authorization");
    const tokenMatch = authorization?.match(/^Bearer[\t ]+([A-Za-z0-9._~+/-]+=*)$/i);
    if (!tokenMatch?.[1]) {
      return responseWithCors(errorResponse(401, "unauthorized", challenge), request, allowedOrigins);
    }

    let principal: OidcPrincipal;
    try {
      principal = await verifier(tokenMatch[1]);
    } catch (error) {
      let status = 500;
      let errorCode = "internal_error";
      if (error instanceof OidcUnavailableError) {
        status = 503;
        errorCode = "authentication_unavailable";
      } else if (error instanceof OidcInvalidTokenError) {
        status = 401;
        errorCode = "unauthorized";
      }
      return responseWithCors(
        errorResponse(status, errorCode, status === 401 ? `${challenge}, error="invalid_token"` : undefined),
        request,
        allowedOrigins,
      );
    }
    if (!principal.isAdmin) {
      return responseWithCors(errorResponse(403, "forbidden"), request, allowedOrigins);
    }

    return responseWithCors(await serverHandler.fetch(request), request, allowedOrigins);
  }

  return {
    fetch,
    close: serverHandler.close,
    protectedResourceMetadataPath,
  };
}
