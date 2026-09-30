import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createCollectionStore, type FeedbackCreateInput, type FeedbackRecord } from "@siteping/core";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSitepingMcpHandler } from "../src/index.js";

const resourceUrl = new URL("https://mcp.siteping.test/api/siteping/mcp");
const projectName = "project-a";
const keyId = "mcp-test-key";

function createFeedback(project: string, message: string, clientId: string): FeedbackCreateInput {
  return {
    projectName: project,
    type: "bug",
    message,
    status: "open",
    url: "https://app.example/checkout",
    urlPattern: "/checkout/:id",
    viewport: "1280x720",
    userAgent: "siteping-mcp-test",
    authorName: "Private Reporter",
    authorEmail: "private@example.test",
    clientId,
    annotations: [],
    screenshotDataUrl: "data:image/jpeg;base64,c2VjcmV0",
    owner: { issuer: "https://identity.example", subject: "private-subject" },
  };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("JWKS server did not bind a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  const closed = once(server, "close");
  server.close();
  await closed;
}

async function signToken(privateKey: CryptoKey, issuer: string, audience: string, groups: string[]): Promise<string> {
  return new SignJWT({ groups })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("mcp-test-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("createSitepingMcpHandler", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires an administrator and keeps reads and status writes inside the configured project", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const pair = await generateKeyPair("RS256");
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: keyId, alg: "RS256", use: "sig" };
    const jwksServer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    const jwksBaseUrl = await listen(jwksServer);
    const issuer = `${jwksBaseUrl}/issuer`;
    const jwksUri = `${jwksBaseUrl}/jwks`;
    const storeRecords: FeedbackRecord[] = [];
    let id = 0;
    const store = createCollectionStore({
      load: () => storeRecords,
      persist: (next) => {
        storeRecords.splice(0, storeRecords.length, ...next);
      },
      generateId: () => `mcp-${++id}`,
    });
    const ownRecord = await store.createFeedback(createFeedback(projectName, "Checkout button is broken", "own-1"));
    const foreignRecord = await store.createFeedback(
      createFeedback("project-b", "Private project feedback", "foreign-1"),
    );
    const handler = createSitepingMcpHandler({
      store,
      projectName,
      resourceUrl,
      oidc: { issuer, jwksUri, rolesClaim: "groups", adminRoles: ["mcp-admin"] },
      allowedOrigins: ["https://agent.example"],
    });
    let transport: StreamableHTTPClientTransport | undefined;
    let client: Client | undefined;
    let legacyTransport: StreamableHTTPClientTransport | undefined;
    let legacyClient: Client | undefined;

    try {
      const adminToken = await signToken(pair.privateKey, issuer, resourceUrl.href, ["mcp-admin"]);
      const memberToken = await signToken(pair.privateKey, issuer, resourceUrl.href, ["member"]);
      const wrongAudienceToken = await signToken(pair.privateKey, issuer, "https://other.example/mcp", ["mcp-admin"]);
      const request = (headers: Record<string, string> = {}) =>
        new Request(resourceUrl, {
          method: "POST",
          headers: { host: resourceUrl.host, ...headers },
          body: "{}",
        });
      const createTransport = (token: string) =>
        new StreamableHTTPClientTransport(resourceUrl, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set("host", resourceUrl.host);
            return handler.fetch(new Request(input, { ...init, headers }));
          },
        });
      const metadataUrl = new URL(handler.protectedResourceMetadataPath, resourceUrl);
      const proxiedMetadata = await handler.fetch(
        new Request(new URL(handler.protectedResourceMetadataPath, "http://localhost:3000"), {
          headers: { host: resourceUrl.host },
        }),
      );
      expect(proxiedMetadata.status).toBe(200);
      expect(await proxiedMetadata.json()).toMatchObject({ resource: resourceUrl.href });
      const metadataResponse = await handler.fetch(
        new Request(metadataUrl, { headers: { host: resourceUrl.host, origin: "https://agent.example" } }),
      );
      expect(metadataResponse.status).toBe(200);
      expect(metadataResponse.headers.get("Access-Control-Allow-Origin")).toBe("https://agent.example");
      expect(await metadataResponse.json()).toEqual({
        resource: resourceUrl.href,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
      });
      const preflight = await handler.fetch(
        new Request(resourceUrl, {
          method: "OPTIONS",
          headers: {
            host: resourceUrl.host,
            origin: "https://agent.example",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization, content-type",
          },
        }),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("authorization, content-type");

      const missing = await handler.fetch(request());
      expect(missing.status).toBe(401);
      expect(missing.headers.get("WWW-Authenticate")).toContain(
        "https://mcp.siteping.test/.well-known/oauth-protected-resource/api/siteping/mcp",
      );
      const wrongAudienceResponse = await handler.fetch(request({ authorization: `Bearer ${wrongAudienceToken}` }));
      const memberResponse = await handler.fetch(request({ authorization: `Bearer ${memberToken}` }));
      const wrongOriginResponse = await handler.fetch(request({ origin: "https://attacker.example" }));
      expect(wrongAudienceResponse.status).toBe(401);
      expect(wrongAudienceResponse.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
      expect(memberResponse.status).toBe(403);
      expect(wrongOriginResponse.status).toBe(403);
      const wrongHostRequest = new Request(resourceUrl, {
        method: "POST",
        headers: { host: "attacker.test" },
        body: "{}",
      });
      expect((await handler.fetch(wrongHostRequest)).status).toBe(403);

      transport = createTransport(adminToken);
      client = new Client(
        { name: "siteping-mcp-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("change_feedback_status");
      const statusTool = tools.tools.find((tool) => tool.name === "change_feedback_status");
      expect(statusTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(statusTool?.inputSchema).toHaveProperty("additionalProperties", false);

      const listCall = await client.callTool({ name: "list_feedback", arguments: { page: 1, limit: 10 } });
      const projectionSchema = z
        .object({
          id: z.string(),
          type: z.literal("bug"),
          message: z.string(),
          status: z.enum(["open", "in_progress", "resolved", "wont_fix"]),
          url: z.string(),
          urlPattern: z.string().nullable(),
          createdAt: z.string(),
          updatedAt: z.string(),
          resolvedAt: z.string().nullable(),
        })
        .strict();
      const listSchema = z
        .object({
          feedbacks: z.array(projectionSchema),
          total: z.number(),
          page: z.number(),
          limit: z.number(),
        })
        .strict();
      const page = listSchema.parse(listCall.structuredContent);
      expect(page).toMatchObject({ total: 1, page: 1, limit: 10 });
      expect(page.feedbacks.map((feedback) => feedback.id)).toEqual([ownRecord.id]);
      expect(page.feedbacks[0]).not.toHaveProperty("authorEmail");
      expect(page.feedbacks[0]).not.toHaveProperty("clientId");
      expect(page.feedbacks[0]).not.toHaveProperty("ownerSubject");
      expect(page.feedbacks[0]).not.toHaveProperty("screenshotUrl");
      const searchCall = await client.callTool({
        name: "search_feedback",
        arguments: { query: "  CHECKOUT BUTTON  ", limit: 10 },
      });
      expect(listSchema.parse(searchCall.structuredContent).feedbacks.map((feedback) => feedback.id)).toEqual([
        ownRecord.id,
      ]);

      const denied = await client.callTool({
        name: "change_feedback_status",
        arguments: { feedbackId: foreignRecord.id, status: "resolved" },
      });
      expect(denied.isError).toBe(true);
      expect((await store.getFeedbacks({ projectName: "project-b" })).feedbacks[0]?.status).toBe("open");

      const resolved = await client.callTool({
        name: "change_feedback_status",
        arguments: { feedbackId: ownRecord.id, status: "resolved" },
      });
      expect(projectionSchema.parse(resolved.structuredContent)).toMatchObject({ status: "resolved" });
      expect(projectionSchema.parse(resolved.structuredContent).resolvedAt).not.toBeNull();

      const reopened = await client.callTool({
        name: "change_feedback_status",
        arguments: { feedbackId: ownRecord.id, status: "open" },
      });
      expect(projectionSchema.parse(reopened.structuredContent)).toMatchObject({ status: "open", resolvedAt: null });
      const persisted = await store.getFeedbacks({ projectName, status: "open" });
      expect(persisted.feedbacks.map((record) => record.id)).toEqual([ownRecord.id]);
      legacyTransport = createTransport(adminToken);
      legacyClient = new Client(
        { name: "siteping-mcp-legacy-test", version: "1.0.0" },
        { versionNegotiation: { mode: "legacy" } },
      );
      await legacyClient.connect(legacyTransport);
      expect((await legacyClient.listTools()).tools.map((tool) => tool.name)).toContain("list_feedback");
      const legacyList = await legacyClient.callTool({ name: "list_feedback", arguments: { limit: 10 } });
      expect(listSchema.parse(legacyList.structuredContent).feedbacks.map((feedback) => feedback.id)).toEqual([
        ownRecord.id,
      ]);
    } finally {
      await legacyClient?.close();
      await legacyTransport?.close();
      await client?.close();
      await transport?.close();
      await handler.close();
      await close(jwksServer);
    }
  });
});
