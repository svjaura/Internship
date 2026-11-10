import type { Metadata } from "next";
import { ORG_DISPLAY } from "@/lib/config";
import OAuthReturn from "../OAuthReturn";
import SiteFrame from "../SiteFrame";

export const metadata: Metadata = { title: "Finishing your connection · Weber Mortgage", referrer: "no-referrer" };

/**
 * Where an OAuth bank (Chase, Wells Fargo, Bank of America) sends the borrower back.
 * Set PLAID_REDIRECT_URI to https://<your-domain>/connect/oauth and add the same
 * URI in the Plaid dashboard (Team settings > API > Allowed redirect URIs).
 */
export default function OAuthPage() {
  return (
    <SiteFrame>
      <OAuthReturn contactFirstName={ORG_DISPLAY.contactFirstName} phone={ORG_DISPLAY.phone} />
    </SiteFrame>
  );
}
