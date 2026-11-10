import type { Metadata } from "next";
import { borrowerRefiViewEnabled, ORG_DISPLAY, plaidConfigured, plaidEnv, privacyNoticeUrl } from "@/lib/config";
import { getStore } from "@/lib/db";
import ConnectFlow from "../ConnectFlow";
import SiteFrame from "../SiteFrame";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connect your mortgage · Weber Mortgage", referrer: "no-referrer" };

export default async function ConnectPage({ params }: { params: Promise<{ invite: string }> }) {
  const { invite: code } = await params;
  const invite = await getStore().getInvite(code);

  if (!invite) {
    return (
      <SiteFrame>
        <h1 className="site-h">This link isn&apos;t valid</h1>
        <p className="site-lead">
          The connect link may be mistyped or no longer active. Please call {ORG_DISPLAY.contact} at {ORG_DISPLAY.phone} for a new one.
        </p>
      </SiteFrame>
    );
  }

  return (
    <SiteFrame>
      <ConnectFlow
        invite={code}
        firstName={invite.firstName}
        orgName={invite.orgName}
        contactName={ORG_DISPLAY.contact}
        contactFirstName={ORG_DISPLAY.contactFirstName}
        phone={ORG_DISPLAY.phone}
        initialState={invite.state}
        plaidMode={plaidConfigured() ? plaidEnv() : "off"}
        privacyUrl={privacyNoticeUrl()}
        refiViewEnabled={borrowerRefiViewEnabled()}
      />
    </SiteFrame>
  );
}
