import type { SitepingMcpOptions } from "@siteping/adapter-prisma/mcp";

type Environment = Readonly<Record<string, string | undefined>>;
type SitepingMcpEnvironmentOptions = Omit<SitepingMcpOptions, "store">;

function readEnv(env: Environment, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

export function sitepingMcpOptionsFromEnv(env: Environment = process.env): SitepingMcpEnvironmentOptions | null {
  const resourceUrlValue = readEnv(env, "SITEPING_MCP_RESOURCE_URL");
  const projectName = readEnv(env, "SITEPING_MCP_PROJECT");
  const issuer = readEnv(env, "SITEPING_MCP_OIDC_ISSUER");
  const jwksUri = readEnv(env, "SITEPING_MCP_OIDC_JWKS_URI");
  const rolesClaim = readEnv(env, "SITEPING_MCP_OIDC_ROLES_CLAIM");
  const adminRolesValue = readEnv(env, "SITEPING_MCP_OIDC_ADMIN_ROLES");
  const allowedOriginsValue = readEnv(env, "SITEPING_MCP_ALLOWED_ORIGINS");
  const settings = [resourceUrlValue, projectName, issuer, jwksUri, rolesClaim, adminRolesValue, allowedOriginsValue];

  if (!settings.some(Boolean)) return null;
  if (!resourceUrlValue || !projectName || !issuer || !jwksUri) {
    throw new Error(
      "[siteping] Set SITEPING_MCP_RESOURCE_URL, SITEPING_MCP_PROJECT, SITEPING_MCP_OIDC_ISSUER, and SITEPING_MCP_OIDC_JWKS_URI together.",
    );
  }

  let resourceUrl: URL;
  try {
    resourceUrl = new URL(resourceUrlValue);
  } catch (cause) {
    throw new TypeError("[siteping] SITEPING_MCP_RESOURCE_URL must be an absolute URL.", { cause });
  }
  if (resourceUrl.pathname !== "/api/siteping/mcp") {
    throw new Error("[siteping] SITEPING_MCP_RESOURCE_URL must use the /api/siteping/mcp path.");
  }

  const adminRoles = adminRolesValue
    ?.split(",")
    .map((role) => role.trim())
    .filter(Boolean) ?? ["admin"];
  if (adminRoles.length === 0) {
    throw new Error("[siteping] SITEPING_MCP_OIDC_ADMIN_ROLES must contain a comma-separated role.");
  }

  let allowedOrigins: string[] | undefined;
  if (allowedOriginsValue) {
    allowedOrigins = allowedOriginsValue.split(",").map((origin) => origin.trim());
    if (allowedOrigins.some((origin) => !origin)) {
      throw new Error("[siteping] SITEPING_MCP_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins.");
    }
  }

  return {
    projectName,
    resourceUrl,
    oidc: {
      issuer,
      jwksUri,
      rolesClaim: rolesClaim ?? "roles",
      adminRoles,
    },
    ...(allowedOrigins ? { allowedOrigins } : {}),
  };
}
