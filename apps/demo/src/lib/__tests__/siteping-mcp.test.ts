import { describe, expect, it } from "vitest";
import { sitepingMcpOptionsFromEnv } from "../siteping-mcp-config";

const configuredEnv = {
  SITEPING_MCP_RESOURCE_URL: "https://siteping.example/api/siteping/mcp",
  SITEPING_MCP_PROJECT: "acme",
  SITEPING_MCP_OIDC_ISSUER: "https://identity.example/",
  SITEPING_MCP_OIDC_JWKS_URI: "https://identity.example/.well-known/jwks.json",
};

describe("sitepingMcpOptionsFromEnv", () => {
  it("disables MCP only when every MCP setting is absent", () => {
    expect(sitepingMcpOptionsFromEnv({})).toBeNull();
    expect(() => sitepingMcpOptionsFromEnv({ SITEPING_MCP_ALLOWED_ORIGINS: "https://agent.example" })).toThrow(
      /Set SITEPING_MCP_RESOURCE_URL, SITEPING_MCP_PROJECT, SITEPING_MCP_OIDC_ISSUER, and SITEPING_MCP_OIDC_JWKS_URI together/,
    );
  });

  it("parses role and exact-origin overrides", () => {
    expect(
      sitepingMcpOptionsFromEnv({
        ...configuredEnv,
        SITEPING_MCP_OIDC_ROLES_CLAIM: "groups",
        SITEPING_MCP_OIDC_ADMIN_ROLES: "siteping-admin, siteping-owner",
        SITEPING_MCP_ALLOWED_ORIGINS: "https://agent.example, http://localhost:4173",
      }),
    ).toEqual({
      projectName: "acme",
      resourceUrl: new URL("https://siteping.example/api/siteping/mcp"),
      oidc: {
        issuer: "https://identity.example/",
        jwksUri: "https://identity.example/.well-known/jwks.json",
        rolesClaim: "groups",
        adminRoles: ["siteping-admin", "siteping-owner"],
      },
      allowedOrigins: ["https://agent.example", "http://localhost:4173"],
    });
  });

  it("rejects resource URLs that cannot map to the mounted route", () => {
    expect(() =>
      sitepingMcpOptionsFromEnv({
        ...configuredEnv,
        SITEPING_MCP_RESOURCE_URL: "https://siteping.example/other",
      }),
    ).toThrow(/must use the \/api\/siteping\/mcp path/);
    expect(() =>
      sitepingMcpOptionsFromEnv({
        ...configuredEnv,
        SITEPING_MCP_OIDC_ADMIN_ROLES: ", ,",
      }),
    ).toThrow(/SITEPING_MCP_OIDC_ADMIN_ROLES must contain/);
  });
});
