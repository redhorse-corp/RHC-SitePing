# Local OIDC demo

`/demo/oidc` is a **local development aid**, not a production authentication example. It exercises the server-side OIDC verifier with the local mock provider.

## Run it

Start the local `mock-oauth` container (`ghcr.io/navikt/mock-oauth2-server:6.0.3`, host port `80` mapped to container port `8080`) with its demo config, then run:

```sh
bun run --cwd apps/demo dev
```

The discovery document advertises issuer `http://localhost/default`, authorization endpoint `http://localhost/default/authorize`, token endpoint `http://localhost/default/token`, and JWKS at `http://localhost/default/jwks`. The page uses Authorization Code + PKCE as documented by the [mock server](https://github.com/navikt/mock-oauth2-server#supported-flows) and [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636).

The Jane/Alex buttons select a mock principal and submit a top-level form POST to `/default/authorize` with the username and the provider's documented optional login-form `claims` value. This skips the provider's standalone chooser page so the request can add the API audience. The provider redirects back with `code` and `state`; the page exchanges the code at `/default/token` with its PKCE verifier. Navigation is used for `/authorize` because its cross-origin redirect cannot be consumed by `fetch`.

- **`jane`** → subject `1234567890`, Jane Doe profile claims, and groups `analysts` + `project-alpha`. With `rolesClaim: "groups"` and `adminRoles: ["project-alpha"]`, the API playground treats Jane as an admin.
- **`alex`** → subject `alex`, Alex Rivera profile claims, and group `analysts`; Alex is a member, not an admin.

Those role settings match the verifier options in `packages/adapter-prisma/src/oidc.ts`. The mock provider documents the interactive login `claims` field in its [`JSON_CONFIG` guidance](https://github.com/navikt/mock-oauth2-server#token-customization-via-json_config).

## Keep the two demos separate

The existing `/demo` widget's `?mode=local` option uses `LocalStorageStore` in the browser and **does not make HTTP requests**. It cannot demonstrate server-side OIDC authorization. Its wiring is in `apps/demo/src/app/(site)/demo/playground.tsx` and `apps/demo/src/app/(site)/demo/inbox/demo-inbox.tsx`.

The OIDC playground instead sends requests through its server-side, development-only `/api/oidc-demo` endpoint using an in-memory store. Its state is transient and is lost when the demo server restarts; it is separate from the browser's localStorage data. The regular HTTP widget path remains `/api/siteping` (`apps/demo/src/app/api/siteping/route.ts`).

The running container's default access token has no `aud` claim. This page uses the mock server's optional login `claims` field to add the distinct API audience to the issued JWT before exchanging the authorization code; the API accepts only the returned `access_token`. The same mock claim may also appear on its ID token, which this page does not use.

This override exists only to make the local mock issue an API-audience token. Do not let a browser choose token claims in production. A real integration must use an access token issued for the API by the identity provider and verify that API audience.

**Primary provider reference:** [navikt/mock-oauth2-server README](https://github.com/navikt/mock-oauth2-server#readme) (testing only; not for production).
