# Local OIDC demo

`/demo/oidc` is a **local development aid**, not a production authentication example. It exercises the server-side OIDC verifier with the local mock provider.

## Run it

Start the local `mock-oauth` container (`ghcr.io/navikt/mock-oauth2-server:6.0.3`, host port `80` mapped to container port `8080`) with its demo config, then run:

```sh
bun run --cwd apps/demo dev
```

The discovery document advertises issuer `http://localhost/default`, authorization endpoint `http://localhost/default/authorize`, token endpoint `http://localhost/default/token`, and JWKS at `http://localhost/default/jwks`. The page uses Authorization Code + PKCE as documented by the [mock server](https://github.com/navikt/mock-oauth2-server#supported-flows) and [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636).

The Jane/Alex buttons select a mock principal and submit a top-level form POST to `/default/authorize` with the username and the provider's documented optional login-form `claims` value. This skips the provider's standalone chooser page so the request can add the API audience. The provider redirects back with `code` and `state`; the page exchanges the code at `/default/token` with its PKCE verifier. Navigation is used for `/authorize` because its cross-origin redirect cannot be consumed by `fetch`.

- **`jane`** → subject `1234567890`, Jane Doe profile claims, and groups `analysts` + `project-alpha`; `project-alpha` is an admin group.
- **`alex`** → subject `alex`, Alex Rivera profile claims, and group `analysts`; `analysts` is also configured as an admin group so Alex can manage feedback.
- A token with only the `member` group is denied GET with `403`; `POST` stays public for widget submissions.

The demo handler uses `rolesClaim: "groups"`, `adminRoles: ["project-alpha", "analysts"]`, `requireAdminForRead: true`, and `allowOwnerDeletes: false`. Groups not listed in `adminRoles` cannot read or manage feedback.

## Keep the two demos separate

The existing `/demo` widget's `?mode=local` option uses `LocalStorageStore` in the browser and **does not make HTTP requests**. It cannot demonstrate server-side OIDC authorization. Its wiring is in `apps/demo/src/app/(site)/demo/playground.tsx` and `apps/demo/src/app/(site)/demo/inbox/demo-inbox.tsx`.

The OIDC playground uses the separate, development-only `/api/oidc-demo` endpoint with an in-memory store. The regular HTTP widget path remains `/api/siteping` (`apps/demo/src/app/api/siteping/route.ts`); it can read the optional `SITEPING_OIDC_*` variables documented in the [Prisma adapter guide](/docs/adapters/prisma#container-environment-for-the-demo-endpoint), and remains open if none are set.

The running container's default access token has no `aud` claim. This page uses the mock server's optional login `claims` field to add the distinct API audience to the issued JWT before exchanging the authorization code; the API accepts only the returned `access_token`. The same mock claim may also appear on its ID token, which this page does not use.

This override exists only to make the local mock issue an API-audience token. Do not let a browser choose token claims in production. A real integration must use an access token issued for the API by the identity provider and verify that API audience.

**Primary provider reference:** [navikt/mock-oauth2-server README](https://github.com/navikt/mock-oauth2-server#readme) (testing only; not for production).
