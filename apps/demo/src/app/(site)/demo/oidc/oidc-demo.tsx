"use client";

import type { FeedbackResponseList } from "@siteping/core";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { OIDC_DEMO } from "@/lib/oidc-demo-config";
import { isRecord } from "@/lib/type-guards";

const LOCAL_VISITOR = { name: "Local visitor", email: "visitor@example.test" };
const BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const OIDC_TRANSACTION_KEY = "siteping_oidc_demo_transaction";

type MockUser = "jane" | "alex";
type OidcUser = { subject: string; name: string; email: string; groups: string[] };
type Session = { accessToken: string; user: OidcUser };
type FeedbackRow = Omit<FeedbackResponseList["feedbacks"][number], "permissions"> & {
  permissions: NonNullable<FeedbackResponseList["feedbacks"][number]["permissions"]>;
};
type FeedbackList = { feedbacks: FeedbackRow[]; canManage: boolean };
type ApiResult = { ok: boolean; status: number; body: unknown };
type OidcTransaction = { state: string; verifier: string; redirectUri: string };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split(".")[1];
  if (!encoded) throw new Error("The mock provider returned a malformed access token.");
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) =>
    char.charCodeAt(0),
  );
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(payload)) throw new Error("The access token payload is not an object.");
  return payload as Record<string, unknown>;
}

function userFromAccessToken(token: string): OidcUser {
  const claims = decodeJwtPayload(token);
  const audience = claims.aud;
  const hasAudience =
    audience === OIDC_DEMO.audience || (Array.isArray(audience) && audience.includes(OIDC_DEMO.audience));
  if (
    claims.iss !== OIDC_DEMO.issuer ||
    !hasAudience ||
    typeof claims.exp !== "number" ||
    claims.exp <= Date.now() / 1000 ||
    typeof claims.sub !== "string" ||
    !claims.sub
  ) {
    throw new Error("The access token issuer, API audience, subject, or expiry did not match this demo.");
  }
  const email = typeof claims.email === "string" ? claims.email : "";
  if (!email) throw new Error("The mock access token did not include an email claim.");
  return {
    subject: claims.sub,
    name: typeof claims.name === "string" ? claims.name : claims.sub,
    email,
    groups: Array.isArray(claims.groups)
      ? claims.groups.filter((group): group is string => typeof group === "string")
      : [],
  };
}

async function apiRequest(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: object,
): Promise<ApiResult> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/oidc-demo?projectName=${encodeURIComponent(OIDC_DEMO.projectName)}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
}

function responseError(body: unknown): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : "Request failed";
}

function readFeedbackList(value: unknown): FeedbackList {
  if (!isRecord(value) || !Array.isArray(value.feedbacks) || !isRecord(value.permissions)) {
    throw new Error("The OIDC API returned an unexpected feedback list.");
  }
  const list = value as unknown as FeedbackResponseList;
  if (typeof list.permissions?.canManage !== "boolean") {
    throw new Error("The OIDC API omitted authorization permissions.");
  }
  const feedbacks = list.feedbacks.map((feedback) => {
    if (!feedback.permissions) throw new Error("The OIDC API omitted a feedback permission.");
    return { ...feedback, permissions: feedback.permissions };
  });
  return { feedbacks, canManage: list.permissions.canManage };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOidcTransaction(value: string | null): OidcTransaction | null {
  if (value === null) return null;
  try {
    const transaction: unknown = JSON.parse(value);
    if (
      !isRecord(transaction) ||
      typeof transaction.state !== "string" ||
      typeof transaction.verifier !== "string" ||
      typeof transaction.redirectUri !== "string"
    ) {
      return null;
    }
    return {
      state: transaction.state,
      verifier: transaction.verifier,
      redirectUri: transaction.redirectUri,
    };
  } catch {
    return null;
  }
}

export default function OidcDemo() {
  const [session, setSession] = useState<Session | null>(null);
  const [feedbacks, setFeedbacks] = useState<FeedbackRow[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [widgetError, setWidgetError] = useState("");

  const widgetName = session?.user.name ?? LOCAL_VISITOR.name;
  const widgetEmail = session?.user.email ?? LOCAL_VISITOR.email;
  const accessToken = session?.accessToken;

  useEffect(() => {
    let cancelled = false;
    let widget: { destroy: () => void } | undefined;
    void import("@siteping/widget")
      .then((widgetModule) => {
        if (cancelled) return;
        widget = widgetModule.initSiteping({
          endpoint: "/api/oidc-demo",
          ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
          projectName: OIDC_DEMO.projectName,
          forceShow: true,
          theme: "light",
          identity: { name: widgetName, email: widgetEmail },
        });
        setWidgetError("");
      })
      .catch((caught: unknown) => {
        if (!cancelled) setWidgetError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
      widget?.destroy();
    };
  }, [accessToken, widgetEmail, widgetName]);
  const callbackStarted = useRef(false);

  useEffect(() => {
    if (callbackStarted.current) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const providerError = params.get("error");
    if (code === null && returnedState === null && providerError === null) return;
    callbackStarted.current = true;
    window.history.replaceState(window.history.state, "", window.location.pathname);
    const transaction = readOidcTransaction(window.sessionStorage.getItem(OIDC_TRANSACTION_KEY));
    window.sessionStorage.removeItem(OIDC_TRANSACTION_KEY);
    if (
      !transaction ||
      returnedState !== transaction.state ||
      transaction.redirectUri !== `${window.location.origin}${window.location.pathname}`
    ) {
      setError("The mock provider returned a callback with an invalid state.");
      return;
    }
    if (providerError !== null) {
      setError(`The mock provider returned ${providerError}.`);
      return;
    }
    if (!code) {
      setError("The mock provider did not return an authorization code.");
      return;
    }

    setBusy(true);
    void (async () => {
      try {
        const tokenResponse = await fetch(`${OIDC_DEMO.issuer}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: OIDC_DEMO.clientId,
            redirect_uri: transaction.redirectUri,
            code,
            code_verifier: transaction.verifier,
          }),
        });
        const tokenBody: unknown = await tokenResponse.json().catch(() => null);
        if (!tokenResponse.ok || !isRecord(tokenBody) || typeof tokenBody.access_token !== "string") {
          throw new Error(`Mock token exchange failed (${tokenResponse.status}).`);
        }

        const accessToken = tokenBody.access_token;
        const user = userFromAccessToken(accessToken);
        const response = await apiRequest(accessToken, "GET");
        if (!response.ok)
          throw new Error(`OIDC API rejected the token (${response.status}): ${responseError(response.body)}`);
        const list = readFeedbackList(response.body);
        setSession({ accessToken, user });
        setFeedbacks(list.feedbacks);
        setCanManage(list.canManage);
        setNotice("The API verified the access token's signature and returned this principal's permissions.");
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  async function beginSignIn(username: MockUser) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
      const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = base64Url(new Uint8Array(challengeBytes));
      const redirectUri = `${window.location.origin}${window.location.pathname}`;
      const authorizeUrl = new URL(`${OIDC_DEMO.issuer}/authorize`);
      authorizeUrl.search = new URLSearchParams({
        client_id: OIDC_DEMO.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();

      window.sessionStorage.setItem(OIDC_TRANSACTION_KEY, JSON.stringify({ state, verifier, redirectUri }));
      const form = document.createElement("form");
      form.method = "POST";
      form.action = authorizeUrl.toString();
      form.hidden = true;
      for (const [name, value] of Object.entries({
        username,
        claims: JSON.stringify({ aud: OIDC_DEMO.audience }),
      })) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      form.submit();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  async function reloadFeedbacks(token = session?.accessToken) {
    if (!token) return;
    const response = await apiRequest(token, "GET");
    if (!response.ok) throw new Error(`GET failed (${response.status}): ${responseError(response.body)}`);
    const list = readFeedbackList(response.body);
    setFeedbacks(list.feedbacks);
    setCanManage(list.canManage);
  }

  async function createOwnedFeedback() {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiRequest(session.accessToken, "POST", {
        projectName: OIDC_DEMO.projectName,
        type: "bug",
        message: `OIDC-owned sample from ${session.user.name}`,
        url: window.location.pathname,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        userAgent: navigator.userAgent,
        authorName: session.user.name,
        authorEmail: session.user.email,
        annotations: [],
        clientId: crypto.randomUUID(),
      });
      if (!response.ok) throw new Error(`POST failed (${response.status}): ${responseError(response.body)}`);
      await reloadFeedbacks(session.accessToken);
      setNotice(`POST accepted. The server attached owner ${session.user.subject} from the verified access token.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function mutateFeedback(row: FeedbackRow, method: "PATCH" | "DELETE") {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const body =
        method === "PATCH"
          ? { id: row.id, projectName: OIDC_DEMO.projectName, status: "resolved" }
          : { id: row.id, projectName: OIDC_DEMO.projectName };
      const response = await apiRequest(session.accessToken, method, body);
      const outcome = response.ok ? "succeeded" : responseError(response.body);
      setNotice(`${method} returned ${response.status}: ${outcome}.`);
      await reloadFeedbacks(session.accessToken);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    setSession(null);
    setFeedbacks([]);
    setCanManage(false);
    setNotice("Signed out locally. The server requires a verified token to read or manage OIDC records.");
    setError("");
  }

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 text-slate-900 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">Local identity lab</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight">OIDC owner permissions</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Sign in through mock-oauth to test server-enforced status and deletion permissions.
            </p>
          </div>
          <Link href="/demo" className="text-sm font-medium text-indigo-700 underline underline-offset-4">
            Back to the main demo
          </Link>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.9fr)]">
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Mock project page</p>
                <h2 className="mt-1 text-xl font-semibold">Northstar workspace</h2>
              </div>
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800">
                OIDC API
              </span>
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-600">
              Feedback from this widget goes to the OIDC demo API. Visitors may submit new feedback; only Jane&apos;s
              administrator role can change status or delete records. Existing browser-local notes are not imported.
            </p>
            <article className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Sprint review</p>
              <h3 className="mt-2 text-lg font-semibold">Client feedback, attached to the page</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Choose Jane or Alex in the panel to the right. The widget and API list use the same server records and
                verified role permissions.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-500">Project status</p>
                  <p className="mt-1 font-medium">In review</p>
                </div>
                <div className="rounded-md border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-500">Next milestone</p>
                  <p className="mt-1 font-medium">Friday, 14:00</p>
                </div>
              </div>
            </article>
            {widgetError && (
              <p className="mt-4 text-sm text-red-700" role="alert">
                Widget failed to start: {widgetError}
              </p>
            )}
            <p className="mt-4 text-xs text-slate-500">
              Widget identity: {widgetName} · {widgetEmail}
            </p>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm" aria-labelledby="oidc-title">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Server-side authorization</p>
            <h2 id="oidc-title" className="mt-1 text-xl font-semibold">
              Mock OIDC session
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Jane or Alex goes to the mock provider with a local-only audience override; it returns a code + state, the
              browser exchanges that code with PKCE, then the API verifies issuer, audience, signature, expiry, and
              groups before returning permissions.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {!session ? (
                <>
                  <button
                    type="button"
                    className={BUTTON_CLASS}
                    onClick={() => void beginSignIn("jane")}
                    disabled={busy}
                  >
                    Sign in as Jane (admin)
                  </button>
                  <button
                    type="button"
                    className={BUTTON_CLASS}
                    onClick={() => void beginSignIn("alex")}
                    disabled={busy}
                  >
                    Sign in as Alex (member)
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={BUTTON_CLASS}
                    onClick={() => void createOwnedFeedback()}
                    disabled={busy}
                  >
                    Create server-owned feedback
                  </button>
                  <button
                    type="button"
                    className={BUTTON_CLASS}
                    onClick={() => void reloadFeedbacks().catch((caught: unknown) => setError(errorMessage(caught)))}
                    disabled={busy}
                  >
                    Refresh API list
                  </button>
                  <button type="button" className={BUTTON_CLASS} onClick={signOut} disabled={busy}>
                    Sign out locally
                  </button>
                </>
              )}
            </div>

            {session && (
              <dl className="mt-4 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 rounded-lg bg-slate-50 p-3 text-sm">
                <dt className="text-slate-500">User</dt>
                <dd className="font-medium">{session.user.name}</dd>
                <dt className="text-slate-500">Subject</dt>
                <dd className="break-all font-mono text-xs">{session.user.subject}</dd>
                <dt className="text-slate-500">Groups</dt>
                <dd>{session.user.groups.join(", ") || "none"}</dd>
                <dt className="text-slate-500">API role</dt>
                <dd>{canManage ? "admin" : "member"}</dd>
              </dl>
            )}

            {notice && (
              <p className="mt-4 rounded-md bg-indigo-50 p-3 text-sm text-indigo-900" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
                {error}
              </p>
            )}

            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold">OIDC API records</h3>
                <span className="text-xs text-slate-500">{feedbacks.length} total · memory store</span>
              </div>
              {!session ? (
                <p className="mt-3 text-sm text-slate-500">Sign in to read records; GET requires a verified token.</p>
              ) : feedbacks.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">No server records yet. Create one as {session.user.name}.</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-200">
                  {feedbacks.map((row) => (
                    <li key={row.id} className="py-3 first:pt-0 last:pb-0">
                      <p className="text-sm font-medium">{row.message}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {row.authorName} · {row.status}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {row.permissions.canChangeStatus && (
                          <button
                            type="button"
                            className={BUTTON_CLASS}
                            onClick={() => void mutateFeedback(row, "PATCH")}
                            disabled={busy}
                          >
                            Resolve
                          </button>
                        )}
                        {row.permissions.canDelete && (
                          <button
                            type="button"
                            className={BUTTON_CLASS}
                            onClick={() => void mutateFeedback(row, "DELETE")}
                            disabled={busy}
                          >
                            Delete
                          </button>
                        )}
                        {!row.permissions.canDelete && !row.permissions.canChangeStatus && (
                          <span className="text-xs text-slate-500">Admin-only actions</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <aside className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          <strong>Server-verified permissions.</strong> The widget and list share the dev-only OIDC API. Requests carry
          the provider&apos;s access token when signed in; visitors may submit feedback, while listing requires a
          verified token. Only the configured admin group can change status or delete individual or all records. The
          provider&apos;s optional login-form <code>claims</code> override supplies this demo&apos;s distinct API
          audience
          <code> {OIDC_DEMO.audience}</code>; never use that mock-only override in production.
        </aside>
      </div>
    </main>
  );
}
