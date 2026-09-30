import { isIP } from "node:net";
import type { JWSAlgorithm, JWTPayload } from "jose";
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";

export interface OidcVerificationOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
  rolesClaim?: string;
  adminRoles?: readonly string[];
}

export interface OidcPrincipal {
  issuer: string;
  subject: string;
  isAdmin: boolean;
}

export class OidcInvalidTokenError extends Error {
  constructor() {
    super("Invalid OIDC access token");
    this.name = "OidcInvalidTokenError";
  }
}

export class OidcUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("OIDC key service unavailable", options);
    this.name = "OidcUnavailableError";
  }
}

const ALLOWED_ALGORITHMS: JWSAlgorithm[] = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

function configuredUrl(value: string, name: string, issuer = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new TypeError(`[siteping] OIDC ${name} must be an absolute URL.`, { cause });
  }

  const localDevelopmentHttp =
    process.env.NODE_ENV === "development" && url.protocol === "http:" && isLoopback(url.hostname);
  if (url.protocol !== "https:" && !localDevelopmentHttp) {
    throw new TypeError(`[siteping] OIDC ${name} must use HTTPS (loopback HTTP is allowed in development).`);
  }
  if (url.username || url.password || url.hash || (issuer && url.search)) {
    throw new TypeError(`[siteping] OIDC ${name} must not contain credentials, a fragment, or an issuer query.`);
  }
  return url;
}

function isJwksDocument(value: unknown): value is { keys: unknown[] } {
  return (
    typeof value === "object" && value !== null && "keys" in value && Array.isArray(value.keys) && value.keys.length > 0
  );
}

/** Create one cached remote-JWKS verifier per handler. */
export function createOidcVerifier(options: OidcVerificationOptions): (token: string) => Promise<OidcPrincipal> {
  if (!options.issuer || !options.audience) {
    throw new TypeError("[siteping] OIDC issuer and audience must be non-empty strings.");
  }

  configuredUrl(options.issuer, "issuer", true);
  const jwksUrl = configuredUrl(options.jwksUri, "jwksUri");
  const rolesClaim = options.rolesClaim ?? "roles";
  const adminRoles = new Set(options.adminRoles ?? ["admin"]);
  const jwks = createRemoteJWKSet(jwksUrl, {
    [customFetch]: async (input, init) => {
      let response: Response;
      try {
        response = await fetch(input, init);
      } catch (cause) {
        throw new OidcUnavailableError({ cause });
      }
      if (response.status !== 200) throw new OidcUnavailableError();
      try {
        if (!isJwksDocument(await response.clone().json())) throw new OidcUnavailableError();
      } catch (cause) {
        if (cause instanceof OidcUnavailableError) throw cause;
        throw new OidcUnavailableError({ cause });
      }
      return response;
    },
  });

  return async (token: string): Promise<OidcPrincipal> => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: options.issuer,
        audience: options.audience,
        requiredClaims: ["exp", "sub"],
        algorithms: ALLOWED_ALGORITHMS,
      }));
    } catch (error) {
      if (
        error instanceof OidcUnavailableError ||
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        error instanceof errors.JWKSMultipleMatchingKeys
      ) {
        throw new OidcUnavailableError({ cause: error });
      }
      throw new OidcInvalidTokenError();
    }

    const subject = payload.sub;
    if (typeof subject !== "string" || subject.trim().length === 0) throw new OidcInvalidTokenError();

    const claim = payload[rolesClaim];
    const roles =
      typeof claim === "string" && claim.length > 0
        ? [claim]
        : Array.isArray(claim) && claim.every((role): role is string => typeof role === "string" && role.length > 0)
          ? claim
          : [];

    return {
      issuer: options.issuer,
      subject,
      isAdmin: roles.some((role) => adminRoles.has(role)),
    };
  };
}
