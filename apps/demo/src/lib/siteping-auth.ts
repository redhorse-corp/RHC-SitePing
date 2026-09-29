import type { OidcOptions } from "@siteping/adapter-prisma";

type Environment = Readonly<Record<string, string | undefined>>;
type SitepingAuthOptions = { oidc: OidcOptions } | { requireAuthForDestructive: false };

function readEnv(env: Environment, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function parseOwnerDeleteSetting(value: string | undefined): boolean {
  if (value === undefined || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  throw new Error('[siteping] SITEPING_OIDC_ALLOW_OWNER_DELETES must be "true" or "false".');
}

export function sitepingAuthFromEnv(env: Environment = process.env): SitepingAuthOptions {
  const issuer = readEnv(env, "SITEPING_OIDC_ISSUER");
  const audience = readEnv(env, "SITEPING_OIDC_AUDIENCE");
  const jwksUri = readEnv(env, "SITEPING_OIDC_JWKS_URI");
  const rolesClaim = readEnv(env, "SITEPING_OIDC_ROLES_CLAIM");
  const adminRolesValue = readEnv(env, "SITEPING_OIDC_ADMIN_ROLES");
  const ownerDeletesValue = readEnv(env, "SITEPING_OIDC_ALLOW_OWNER_DELETES");

  if (![issuer, audience, jwksUri, rolesClaim, adminRolesValue, ownerDeletesValue].some(Boolean)) {
    return { requireAuthForDestructive: false };
  }
  if (!issuer || !audience || !jwksUri) {
    throw new Error(
      "[siteping] Set SITEPING_OIDC_ISSUER, SITEPING_OIDC_AUDIENCE, and SITEPING_OIDC_JWKS_URI together.",
    );
  }

  const adminRoles =
    adminRolesValue === undefined
      ? ["admin"]
      : adminRolesValue
          .split(",")
          .map((role) => role.trim())
          .filter(Boolean);
  if (adminRoles.length === 0) {
    throw new Error("[siteping] SITEPING_OIDC_ADMIN_ROLES must contain a comma-separated role.");
  }

  return {
    oidc: {
      issuer,
      audience,
      jwksUri,
      rolesClaim: rolesClaim ?? "roles",
      adminRoles,
      allowOwnerDeletes: parseOwnerDeleteSetting(ownerDeletesValue),
    },
  };
}
