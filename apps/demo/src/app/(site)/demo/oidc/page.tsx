import type { Metadata } from "next";
import { notFound } from "next/navigation";
import OidcDemo from "./oidc-demo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "OIDC demo — SitePing",
  description: "Try mock OIDC sign-in with administrator-only feedback mutations.",
};

export default function OidcDemoPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <OidcDemo />;
}
