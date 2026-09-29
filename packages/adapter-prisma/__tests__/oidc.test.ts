import { createServer, type Server } from "node:http";
import { type CollectionStore, createCollectionStore, type FeedbackRecord, type SitepingStore } from "@siteping/core";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSitepingHandler, type HandlerOptions, type OidcOptions, type SitepingHandler } from "../src/index.js";
import { validPayloadNoAnnotations } from "./fixtures.js";

const ISSUER_PATH = "/issuer";
const AUDIENCE = "https://api.siteping.test";
const KEY_ID = "siteping-test-key";
const PROJECT = "test-project";

let server: Server;
let issuer = "";
let jwksUri = "";
let jwksStatus = 200;
let signingKey: CryptoKey;
let jwksBody = "";

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };
  jwksBody = JSON.stringify({ keys: [publicJwk] });

  server = createServer((_request, response) => {
    response.writeHead(jwksStatus, { "Content-Type": "application/json" });
    response.end(jwksStatus === 200 ? jwksBody : "unavailable");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test JWKS server did not bind a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  issuer = `${baseUrl}${ISSUER_PATH}`;
  jwksUri = `${baseUrl}/jwks`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  jwksStatus = 200;
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface TokenOptions {
  issuer?: string;
  audience?: string | string[];
  subject?: string | null;
  expiresAt?: string | number | null;
  notBefore?: number;
  roles?: unknown;
  key?: CryptoKey;
}

async function signToken(options: TokenOptions = {}): Promise<string> {
  const roles = options.roles === undefined ? {} : { roles: options.roles };
  let token = new SignJWT(roles)
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt();
  if (options.subject !== null) token = token.setSubject(options.subject ?? "member-1");
  if (options.expiresAt !== null) token = token.setExpirationTime(options.expiresAt ?? "5m");
  if (options.notBefore !== undefined) token = token.setNotBefore(options.notBefore);
  return token.sign(options.key ?? signingKey);
}

function oidcOptions(overrides: Partial<OidcOptions> = {}): OidcOptions {
  return { issuer, audience: AUDIENCE, jwksUri, ...overrides };
}

function makeStore(): CollectionStore {
  let records: FeedbackRecord[] = [];
  let id = 0;
  return createCollectionStore({
    load: () => records,
    persist: (next) => {
      records = next;
    },
    generateId: () => `oidc-${++id}`,
  });
}

type HandlerOverrides = Omit<HandlerOptions, "store" | "oidc">;

function makeHandler(
  store: SitepingStore = makeStore(),
  handlerOverrides: HandlerOverrides = {},
  oidcOverrides: Partial<OidcOptions> = {},
): SitepingHandler {
  return createSitepingHandler({ store, oidc: oidcOptions(oidcOverrides), ...handlerOverrides });
}

function postRequest(body: unknown, authorization?: string): Request {
  return new Request("http://siteping.test/api/siteping", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
  });
}

function getRequest(authorization?: string): Request {
  return new Request(`http://siteping.test/api/siteping?projectName=${PROJECT}`, {
    ...(authorization ? { headers: { Authorization: authorization } } : {}),
  });
}

function patchRequest(id: string, authorization?: string, projectName = PROJECT): Request {
  return new Request("http://siteping.test/api/siteping", {
    method: "PATCH",
    body: JSON.stringify({ id, projectName, status: "resolved" }),
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
  });
}

function deleteRequest(id: string, authorization?: string, projectName = PROJECT): Request {
  return new Request("http://siteping.test/api/siteping", {
    method: "DELETE",
    body: JSON.stringify({ id, projectName }),
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
  });
}

function deleteAllRequest(authorization?: string): Request {
  return new Request("http://siteping.test/api/siteping", {
    method: "DELETE",
    body: JSON.stringify({ projectName: PROJECT, deleteAll: true }),
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
  });
}

const bearer = (token: string): string => `Bearer ${token}`;

type WireFeedback = {
  id: string;
  authorName: string;
  authorEmail: string;
  status: string;
  permissions?: { canDelete: boolean; canChangeStatus: boolean };
};

type WireList = {
  feedbacks: WireFeedback[];
  total: number;
  permissions?: { canManage: boolean };
};

describe("OIDC JWT verification", () => {
  it("accepts signed audience tokens, ignores submitted owner and role claims, and emits effective capabilities", async () => {
    const handler = makeHandler();
    const memberToken = await signToken({ subject: "member-a", roles: ["member"] });
    const response = await handler.POST(
      postRequest(
        {
          ...validPayloadNoAnnotations,
          owner: { issuer: "https://attacker.test", subject: "administrator" },
          ownerIssuer: "https://attacker.test",
          ownerSubject: "administrator",
          roles: ["admin"],
        },
        bearer(memberToken),
      ),
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as WireFeedback;
    expect(created.permissions).toEqual({ canDelete: true, canChangeStatus: false });
    expect(created).not.toHaveProperty("ownerIssuer");
    expect(created).not.toHaveProperty("ownerSubject");

    const listResponse = await handler.GET(getRequest(bearer(memberToken)));
    const list = (await listResponse.json()) as WireList;
    expect(list.permissions).toEqual({ canManage: false });
    expect(list.feedbacks[0]?.permissions).toEqual({ canDelete: true, canChangeStatus: false });
    expect(list.feedbacks[0]?.authorEmail).toBe("alice@example.com");
  });

  it("rejects invalid signatures, issuer, audience, subject, expiry, and future nbf", async () => {
    const alternatePair = await generateKeyPair("RS256");
    const invalidTokens = [
      await signToken({ key: alternatePair.privateKey }),
      await signToken({ issuer: "https://wrong-issuer.test" }),
      await signToken({ audience: "https://wrong-api.test" }),
      await signToken({ subject: null }),
      await signToken({ expiresAt: null }),
      await signToken({ expiresAt: Math.floor(Date.now() / 1000) - 60 }),
      await signToken({ notBefore: Math.floor(Date.now() / 1000) + 60 }),
    ];

    for (const token of invalidTokens) {
      const response = await makeHandler().GET(getRequest(bearer(token)));
      expect(response.status).toBe(401);
    }
  });

  it("treats unmapped and malformed role claims as non-admin while honoring configured claims", async () => {
    const handler = makeHandler();
    for (const roles of [undefined, ["reviewer"], ["admin", 7], { admin: true }]) {
      const token = await signToken({ roles });
      const response = await handler.GET(getRequest(bearer(token)));
      expect(response.status).toBe(200);
      const list = (await response.json()) as WireList;
      expect(list.permissions).toEqual({ canManage: false });
    }

    const configured = makeHandler(makeStore(), {}, { rolesClaim: "groups", adminRoles: ["siteping-admin"] });
    const signedGroupsToken = await new SignJWT({ groups: ["siteping-admin"] })
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setSubject("admin-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);
    const response = await configured.GET(getRequest(bearer(signedGroupsToken)));
    const list = (await response.json()) as WireList;
    expect(list.permissions).toEqual({ canManage: true });
  });

  it("returns 503 when the issuer JWKS endpoint is unavailable", async () => {
    jwksStatus = 503;
    const token = await signToken({ subject: "member-a" });
    const response = await makeHandler().GET(getRequest(bearer(token)));
    expect(response.status).toBe(503);
  });

  it("allows anonymous public requests but rejects an invalid supplied token", async () => {
    const handler = makeHandler();
    expect((await handler.GET(getRequest())).status).toBe(401);

    const anonymousPost = await handler.POST(postRequest({ ...validPayloadNoAnnotations, clientId: "anonymous" }));
    expect(anonymousPost.status).toBe(201);
    const anonymousRecord = (await anonymousPost.json()) as WireFeedback;
    expect(anonymousRecord.permissions).toEqual({
      canDelete: false,
      canChangeStatus: false,
    });

    const invalidPost = await handler.POST(
      postRequest({ ...validPayloadNoAnnotations, clientId: "invalid-token" }, "Bearer not-a-jwt"),
    );
    expect(invalidPost.status).toBe(401);

    const member = bearer(await signToken({ subject: "member-a", roles: ["member"] }));
    const publicGet = makeHandler(makeStore(), { publicEndpoints: ["GET", "POST", "OPTIONS"] });
    const ownerPost = await publicGet.POST(
      postRequest({ ...validPayloadNoAnnotations, clientId: "public-get-row" }, member),
    );
    expect(ownerPost.status).toBe(201);

    const anonymousGetResponse = await publicGet.GET(getRequest());
    const anonymousList = (await anonymousGetResponse.json()) as WireList;
    expect(anonymousList.permissions).toEqual({ canManage: false });
    expect(anonymousList.feedbacks).toHaveLength(1);
    expect(anonymousList.feedbacks[0]?.permissions).toEqual({ canDelete: false, canChangeStatus: false });
    expect(anonymousList.feedbacks[0]?.authorEmail).toBe("");
    const memberList = (await (await publicGet.GET(getRequest(member))).json()) as WireList;
    expect(memberList.feedbacks[0]?.permissions).toEqual({ canDelete: true, canChangeStatus: false });
    expect(memberList.feedbacks[0]?.authorEmail).toBe("alice@example.com");
    expect((await publicGet.GET(getRequest("Bearer invalid-token"))).status).toBe(401);

    const publicMutations = makeHandler(makeStore(), {
      publicEndpoints: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    });
    expect((await publicMutations.PATCH(patchRequest("missing"))).status).toBe(401);
    expect((await publicMutations.DELETE(deleteRequest("missing"))).status).toBe(401);
    expect((await publicMutations.PATCH(patchRequest("missing", member))).status).toBe(404);
    expect((await publicMutations.DELETE(deleteAllRequest(member))).status).toBe(403);
  });

  it("requires HTTPS except for loopback URLs in development and forbids the legacy destructive escape hatch", () => {
    expect(() => makeHandler(makeStore(), { requireAuthForDestructive: false })).toThrow(/cannot be disabled/);
    expect(() => makeHandler(makeStore(), {}, { issuer: "http://issuer.example" })).toThrow(/must use HTTPS/);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => makeHandler()).toThrow(/must use HTTPS/);
    expect(() =>
      createSitepingHandler({
        store: makeStore(),
        oidc: {
          issuer: "https://issuer.example",
          audience: AUDIENCE,
          jwksUri: "https://issuer.example/jwks",
        },
      }),
    ).not.toThrow();
  });
});

describe("OIDC feedback authorization", () => {
  it("allows feedback owners to delete only their own records by default", async () => {
    const store = makeStore();
    const handler = makeHandler(store);
    const alice = bearer(await signToken({ subject: "alice", roles: ["member"] }));
    const bob = bearer(await signToken({ subject: "bob", roles: "member" }));
    const admin = bearer(await signToken({ subject: "administrator", roles: "admin" }));

    const aliceResponse = await handler.POST(
      postRequest({ ...validPayloadNoAnnotations, clientId: "alice-feedback" }, alice),
    );
    const bobResponse = await handler.POST(
      postRequest({ ...validPayloadNoAnnotations, clientId: "bob-feedback", authorName: "Bob" }, bob),
    );
    const legacyResponse = await handler.POST(
      postRequest({ ...validPayloadNoAnnotations, clientId: "legacy-feedback", authorName: "Legacy" }),
    );
    expect(aliceResponse.status).toBe(201);
    expect(bobResponse.status).toBe(201);
    expect(legacyResponse.status).toBe(201);
    const aliceRecord = (await aliceResponse.json()) as WireFeedback;
    const bobRecord = (await bobResponse.json()) as WireFeedback;
    const legacyRecord = (await legacyResponse.json()) as WireFeedback;
    expect(aliceRecord.permissions).toEqual({ canDelete: true, canChangeStatus: false });

    const memberList = (await (await handler.GET(getRequest(alice))).json()) as WireList;
    expect(memberList.permissions).toEqual({ canManage: false });
    expect(memberList.feedbacks.find((feedback) => feedback.id === aliceRecord.id)?.permissions).toEqual({
      canDelete: true,
      canChangeStatus: false,
    });
    expect(memberList.feedbacks.find((feedback) => feedback.id === bobRecord.id)?.permissions).toEqual({
      canDelete: false,
      canChangeStatus: false,
    });
    expect(memberList.feedbacks.find((feedback) => feedback.id === legacyRecord.id)?.permissions).toEqual({
      canDelete: false,
      canChangeStatus: false,
    });

    expect((await handler.PATCH(patchRequest(aliceRecord.id, alice, "other-project"))).status).toBe(404);
    expect((await handler.PATCH(patchRequest(aliceRecord.id, alice))).status).toBe(403);
    expect((await handler.DELETE(deleteRequest(bobRecord.id, alice))).status).toBe(403);
    expect((await handler.DELETE(deleteRequest(legacyRecord.id, alice))).status).toBe(403);
    expect((await handler.DELETE(deleteRequest(aliceRecord.id, alice, "other-project"))).status).toBe(404);
    expect((await handler.DELETE(deleteRequest(aliceRecord.id, alice))).status).toBe(200);
    expect((await handler.DELETE(deleteAllRequest(alice))).status).toBe(403);

    const adminList = (await (await handler.GET(getRequest(admin))).json()) as WireList;
    expect(adminList.permissions).toEqual({ canManage: true });
    expect(adminList.feedbacks.every((feedback) => feedback.permissions?.canDelete === true)).toBe(true);
    expect(adminList.feedbacks.every((feedback) => feedback.permissions?.canChangeStatus === true)).toBe(true);
    expect((await handler.PATCH(patchRequest(bobRecord.id, admin))).status).toBe(200);
    expect((await handler.DELETE(deleteRequest(legacyRecord.id, admin))).status).toBe(200);
    expect((await handler.DELETE(deleteRequest(bobRecord.id, admin))).status).toBe(200);
    expect((await handler.DELETE(deleteAllRequest(admin))).status).toBe(200);
  });
  it("can restrict every OIDC delete to administrators", async () => {
    const handler = makeHandler(makeStore(), {}, { allowOwnerDeletes: false });
    const alice = bearer(await signToken({ subject: "alice", roles: ["member"] }));
    const admin = bearer(await signToken({ subject: "administrator", roles: "admin" }));
    const created = await handler.POST(
      postRequest({ ...validPayloadNoAnnotations, clientId: "admin-only-delete" }, alice),
    );
    expect(created.status).toBe(201);
    const feedback = (await created.json()) as WireFeedback;
    expect(feedback.permissions).toEqual({ canDelete: false, canChangeStatus: false });

    const memberList = (await (await handler.GET(getRequest(alice))).json()) as WireList;
    expect(memberList.feedbacks[0]?.permissions).toEqual({ canDelete: false, canChangeStatus: false });
    expect((await handler.PATCH(patchRequest(feedback.id, alice))).status).toBe(403);
    expect((await handler.DELETE(deleteRequest(feedback.id, alice))).status).toBe(403);
    expect((await handler.DELETE(deleteAllRequest(alice))).status).toBe(403);
    expect((await handler.DELETE(deleteRequest(feedback.id, admin))).status).toBe(200);
  });

  it("denies owner deletes when a custom store cannot verify ownership", async () => {
    const store: SitepingStore = makeStore();
    delete store.verifyFeedbackOwner;
    const handler = makeHandler(store);
    const alice = bearer(await signToken({ subject: "alice", roles: ["member"] }));
    const created = await handler.POST(postRequest(validPayloadNoAnnotations, alice));
    const feedback = (await created.json()) as WireFeedback;

    expect(feedback.permissions).toEqual({ canDelete: false, canChangeStatus: false });
    expect((await handler.DELETE(deleteRequest(feedback.id, alice))).status).toBe(403);
  });

  it("returns 409 without record data for duplicate clientId replay by another owner", async () => {
    const handler = makeHandler();
    const alice = bearer(await signToken({ subject: "alice", roles: ["member"] }));
    const bob = bearer(await signToken({ subject: "bob", roles: ["member"] }));
    const ownerResponse = await handler.POST(
      postRequest({ ...validPayloadNoAnnotations, clientId: "replay-key" }, alice),
    );
    expect(ownerResponse.status).toBe(201);

    const denied = await handler.POST(postRequest({ ...validPayloadNoAnnotations, clientId: "replay-key" }, bob));
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "clientId already used" });

    const replayedByOwner = await handler.POST(
      postRequest({ ...validPayloadNoAnnotations, clientId: "replay-key" }, alice),
    );
    expect(replayedByOwner.status).toBe(201);
    const replayedRecord = (await replayedByOwner.json()) as WireFeedback;
    expect(replayedRecord.permissions).toEqual({
      canDelete: true,
      canChangeStatus: false,
    });
  });

  it("keeps an API key as an administrator principal when OIDC is enabled", async () => {
    const store = makeStore();
    const handler = makeHandler(store, { apiKey: "legacy-admin-key" });
    const response = await handler.POST(
      postRequest({ ...validPayloadNoAnnotations, clientId: "api-key-feedback" }, "Bearer legacy-admin-key"),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as WireFeedback;
    expect(created.permissions).toEqual({ canDelete: true, canChangeStatus: true });
    expect(created).not.toHaveProperty("ownerIssuer");

    const list = (await (await handler.GET(getRequest("Bearer legacy-admin-key"))).json()) as WireList;
    expect(list.permissions).toEqual({ canManage: true });
    expect((await handler.DELETE(deleteAllRequest("Bearer legacy-admin-key"))).status).toBe(200);
  });
});
