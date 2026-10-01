import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { MemoryStore } from "../packages/adapter-memory/src/index.js";

const requireFromMcp = createRequire(new URL("../packages/mcp/package.json", import.meta.url));
const { createSitepingMcpHandler } = requireFromMcp("@siteping/mcp");
const { Client, StreamableHTTPClientTransport } = requireFromMcp("@modelcontextprotocol/client");
const { exportJWK, generateKeyPair, SignJWT } = requireFromMcp("jose");

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";

let handler;
let currentClient;
let currentTransport;
let legacyClient;
let legacyTransport;
let publicJwk;

const store = new MemoryStore();
const jwksServer = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ keys: [publicJwk] }));
});
const apiServer = createServer((request, response) => {
  void forward(request, response);
});

async function forward(incoming, outgoing) {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const method = incoming.method ?? "GET";
    const init = { method, headers };
    if (body.length > 0) init.body = body.toString();
    const requestUrl = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
    const result = await handler.fetch(new Request(requestUrl, init));
    outgoing.writeHead(result.status, Object.fromEntries(result.headers));
    outgoing.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    outgoing.writeHead(500);
    outgoing.end();
  }
}

async function listen(server) {
  const { promise, resolve, reject } = Promise.withResolvers();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback server did not bind a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  const { promise, resolve, reject } = Promise.withResolvers();
  server.close((error) => (error ? reject(error) : resolve()));
  await promise;
}

async function tokenFor(privateKey, issuer, audience, groups) {
  return new SignJWT({ groups })
    .setProtectedHeader({ alg: "RS256", kid: "mcp-smoke-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("mcp-smoke-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function feedback(projectName, message, clientId) {
  return {
    projectName,
    type: "bug",
    message,
    status: "open",
    url: "https://example.test/checkout",
    urlPattern: "/checkout",
    viewport: "1280x720",
    userAgent: "siteping-mcp-smoke",
    authorName: "Smoke Test",
    authorEmail: "private@example.test",
    clientId,
    annotations: [],
    screenshotDataUrl: "data:image/jpeg;base64,c2VjcmV0",
  };
}

async function main() {
  const keyPair = await generateKeyPair("RS256");
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: "mcp-smoke-key",
    alg: "RS256",
    use: "sig",
  };
  const jwksBaseUrl = await listen(jwksServer);
  const appBaseUrl = await listen(apiServer);
  const issuer = `${jwksBaseUrl}/issuer`;
  const jwksUri = `${jwksBaseUrl}/jwks`;
  const resourceUrl = new URL("/api/siteping/mcp", appBaseUrl);
  const projectName = "mcp-smoke-project";
  handler = createSitepingMcpHandler({
    store,
    projectName,
    resourceUrl,
    oidc: { issuer, jwksUri, rolesClaim: "groups", adminRoles: ["mcp-admin"] },
  });
  const ownRecord = await store.createFeedback(feedback(projectName, "Smoke test feedback", "own-1"));
  const secondRecord = await store.createFeedback(feedback(projectName, "Another smoke result", "own-2"));
  const foreignRecord = await store.createFeedback(feedback("mcp-smoke-other", "Foreign feedback", "foreign-1"));

  const metadataUrl = new URL(handler.protectedResourceMetadataPath, resourceUrl);
  const metadataResponse = await fetch(metadataUrl);
  assert.equal(metadataResponse.status, 200);
  assert.equal(metadataResponse.headers.get("vary"), "Origin");
  assert.deepEqual(await metadataResponse.json(), {
    resource: resourceUrl.href,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  });
  const unauthenticated = await fetch(resourceUrl, { method: "POST", body: "{}" });
  assert.equal(unauthenticated.status, 401);
  const challenge = unauthenticated.headers.get("www-authenticate");
  assert.ok(challenge?.includes(metadataUrl.href));

  const adminToken = await tokenFor(keyPair.privateKey, issuer, resourceUrl.href, ["mcp-admin"]);
  const memberToken = await tokenFor(keyPair.privateKey, issuer, resourceUrl.href, ["member"]);
  const wrongAudienceToken = await tokenFor(keyPair.privateKey, issuer, "https://other.example/mcp", ["mcp-admin"]);
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };
  const memberResponse = await fetch(resourceUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${memberToken}` },
    body: "{}",
  });
  const wrongAudienceResponse = await fetch(resourceUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${wrongAudienceToken}` },
    body: "{}",
  });
  assert.equal(memberResponse.status, 403);
  assert.equal(wrongAudienceResponse.status, 401);
  const wrongOriginRequest = new Request(resourceUrl, {
    method: "POST",
    headers: { host: resourceUrl.host, origin: "https://attacker.test" },
    body: "{}",
  });
  const wrongOriginResponse = await handler.fetch(wrongOriginRequest);
  const wrongHostRequest = new Request(resourceUrl, {
    method: "POST",
    headers: { host: "attacker.test" },
    body: "{}",
  });
  const wrongHostResponse = await handler.fetch(wrongHostRequest);
  assert.equal(wrongOriginResponse.status, 403);
  assert.equal(wrongHostResponse.status, 403);

  const requestInit = { headers: adminHeaders };
  currentTransport = new StreamableHTTPClientTransport(resourceUrl, { requestInit });
  currentClient = new Client(
    { name: "siteping-mcp-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await currentClient.connect(currentTransport);
  const tools = await currentClient.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "change_feedback_status"));

  const firstPage = await currentClient.callTool({
    name: "list_feedback",
    arguments: { type: "bug", status: "open", page: 1, limit: 1 },
  });
  const secondPage = await currentClient.callTool({
    name: "list_feedback",
    arguments: { type: "bug", status: "open", page: 2, limit: 1 },
  });
  assert.equal(firstPage.structuredContent.total, 2);
  assert.equal(firstPage.structuredContent.limit, 1);
  assert.deepEqual(
    [firstPage.structuredContent.feedbacks[0].id, secondPage.structuredContent.feedbacks[0].id].sort(),
    [ownRecord.id, secondRecord.id].sort(),
  );
  const safeFeedback = firstPage.structuredContent.feedbacks[0];
  assert.deepEqual(Object.keys(safeFeedback).sort(), [
    "createdAt",
    "id",
    "message",
    "resolvedAt",
    "status",
    "type",
    "updatedAt",
    "url",
    "urlPattern",
  ]);
  assert.equal("authorEmail" in safeFeedback, false);
  assert.equal("screenshotDataUrl" in safeFeedback, false);
  const search = await currentClient.callTool({
    name: "search_feedback",
    arguments: { query: "smoke test feedback", limit: 10 },
  });
  assert.deepEqual(
    search.structuredContent.feedbacks.map((record) => record.id),
    [ownRecord.id],
  );

  const deniedWrite = await currentClient.callTool({
    name: "change_feedback_status",
    arguments: { feedbackId: foreignRecord.id, status: "resolved" },
  });
  assert.equal(deniedWrite.isError, true);
  const foreignState = await store.getFeedbacks({ projectName: "mcp-smoke-other", limit: 10 });
  assert.equal(foreignState.feedbacks[0].status, "open");
  const changed = await currentClient.callTool({
    name: "change_feedback_status",
    arguments: { feedbackId: ownRecord.id, status: "resolved" },
  });
  assert.equal(changed.structuredContent.status, "resolved");
  assert.ok(changed.structuredContent.resolvedAt);
  const reopened = await currentClient.callTool({
    name: "change_feedback_status",
    arguments: { feedbackId: ownRecord.id, status: "open" },
  });
  assert.equal(reopened.structuredContent.status, "open");
  assert.equal(reopened.structuredContent.resolvedAt, null);
  const persisted = await store.getFeedbacks({ projectName, status: "open", limit: 10 });
  assert.ok(persisted.feedbacks.some((record) => record.id === ownRecord.id));

  legacyTransport = new StreamableHTTPClientTransport(resourceUrl, { requestInit });
  legacyClient = new Client(
    { name: "siteping-mcp-smoke-legacy", version: "1.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  await legacyClient.connect(legacyTransport);
  const legacyList = await legacyClient.callTool({ name: "list_feedback", arguments: { limit: 10 } });
  assert.ok(legacyList.structuredContent.feedbacks.some((record) => record.id === ownRecord.id));
}

async function verifyNextHost() {
  const [baseUrl, resource, unexpected] = process.argv.slice(2);
  assert.equal(unexpected, undefined, "Expected only the Next base URL and public MCP URL");
  if (!baseUrl && !resource) return;
  assert.ok(baseUrl && resource, "Provide both Next smoke URLs");
  const resourceUrl = new URL(resource);
  const headers = { host: resourceUrl.host, "x-forwarded-proto": resourceUrl.protocol.slice(0, -1) };
  const metadataPath = `/.well-known/oauth-protected-resource${resourceUrl.pathname}`;
  const metadata = await fetch(new URL(metadataPath, baseUrl), { headers });
  assert.equal(metadata.status, 200, "Mounted Next metadata supports an external resource URL");
  assert.equal((await metadata.json()).resource, resourceUrl.href);
  const endpoint = new URL(resourceUrl.pathname, baseUrl);
  const unauthenticated = await fetch(endpoint, { method: "POST", headers, body: "{}" });
  assert.equal(unauthenticated.status, 401);
  assert.ok(unauthenticated.headers.get("www-authenticate")?.includes(metadataPath));
  const deniedOrigin = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, origin: "https://attacker.test" },
    body: "{}",
  });
  assert.equal(deniedOrigin.status, 403);
  const deniedHost = await fetch(new URL(metadataPath, baseUrl), {
    headers: { ...headers, host: "attacker.test" },
  });
  assert.equal(deniedHost.status, 403);
}

try {
  await main();
  await verifyNextHost();
  console.log("MCP smoke passed");
} finally {
  await legacyClient?.close();
  await legacyTransport?.close();
  await currentClient?.close();
  await currentTransport?.close();
  await handler?.close();
  await close(apiServer);
  await close(jwksServer);
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
}
