import { describe, expect, it } from "vitest";
import { sitepingAuthFromEnv } from "../siteping-auth";

describe("sitepingAuthFromEnv", () => {
  it("keeps the demo open when no OIDC variables are configured", () => {
    expect(sitepingAuthFromEnv({})).toEqual({ requireAuthForDestructive: false });
  });

  it("enables OIDC from container variables and parses policy overrides", () => {
    expect(
      sitepingAuthFromEnv({
        SITEPING_OIDC_ISSUER: "https://issuer.example/",
        SITEPING_OIDC_AUDIENCE: "siteping-api",
        SITEPING_OIDC_JWKS_URI: "https://issuer.example/jwks",
        SITEPING_OIDC_ROLES_CLAIM: "groups",
        SITEPING_OIDC_ADMIN_ROLES: "siteping-admin, siteping-owner",
        SITEPING_OIDC_ALLOW_OWNER_DELETES: "true",
        SITEPING_OIDC_REQUIRE_ADMIN_FOR_READ: "false",
      }),
    ).toEqual({
      oidc: {
        issuer: "https://issuer.example/",
        audience: "siteping-api",
        jwksUri: "https://issuer.example/jwks",
        rolesClaim: "groups",
        adminRoles: ["siteping-admin", "siteping-owner"],
        allowOwnerDeletes: true,
        requireAdminForRead: false,
      },
    });

    expect(
      sitepingAuthFromEnv({
        SITEPING_OIDC_ISSUER: "https://issuer.example/",
        SITEPING_OIDC_AUDIENCE: "siteping-api",
        SITEPING_OIDC_JWKS_URI: "https://issuer.example/jwks",
      }),
    ).toEqual({
      oidc: {
        issuer: "https://issuer.example/",
        audience: "siteping-api",
        jwksUri: "https://issuer.example/jwks",
        rolesClaim: "roles",
        adminRoles: ["admin"],
        allowOwnerDeletes: false,
        requireAdminForRead: true,
      },
    });
  });

  it("rejects partial OIDC configuration instead of falling back open", () => {
    expect(() => sitepingAuthFromEnv({ SITEPING_OIDC_ISSUER: "https://issuer.example/" })).toThrow(
      /Set SITEPING_OIDC_ISSUER, SITEPING_OIDC_AUDIENCE, and SITEPING_OIDC_JWKS_URI together/,
    );
  });

  it("rejects invalid delete-policy values", () => {
    expect(() =>
      sitepingAuthFromEnv({
        SITEPING_OIDC_ISSUER: "https://issuer.example/",
        SITEPING_OIDC_AUDIENCE: "siteping-api",
        SITEPING_OIDC_JWKS_URI: "https://issuer.example/jwks",
        SITEPING_OIDC_ALLOW_OWNER_DELETES: "sometimes",
      }),
    ).toThrow(/SITEPING_OIDC_ALLOW_OWNER_DELETES must be "true" or "false"/);
    expect(() =>
      sitepingAuthFromEnv({
        SITEPING_OIDC_ISSUER: "https://issuer.example/",
        SITEPING_OIDC_AUDIENCE: "siteping-api",
        SITEPING_OIDC_JWKS_URI: "https://issuer.example/jwks",
        SITEPING_OIDC_REQUIRE_ADMIN_FOR_READ: "sometimes",
      }),
    ).toThrow(/SITEPING_OIDC_REQUIRE_ADMIN_FOR_READ must be "true" or "false"/);
  });
});
