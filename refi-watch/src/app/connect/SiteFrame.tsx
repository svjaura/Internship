import { ORG_DISPLAY } from "@/lib/config";

/** Weber Mortgage branded frame for borrower pages. Server component. */
export default function SiteFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="site-nav">
        <div className="site-nav-in">
          <span className="site-logo">{ORG_DISPLAY.name}</span>
          <a className="site-phone" href={`tel:${ORG_DISPLAY.phone.replace(/[^0-9]/g, "")}`}>
            {ORG_DISPLAY.phone}
          </a>
        </div>
      </header>
      <main className="site-main">
        {children}
        <footer className="site-foot">{ORG_DISPLAY.legal}</footer>
      </main>
    </>
  );
}
