/**
 * Data access layer. Server only.
 *
 * With Supabase keys: Postgres through @supabase/supabase-js with the service role key
 * (never sent to the browser). The caller must already have checked staff membership
 * or the invite code; this layer scopes every query by org_id.
 *
 * Without Supabase keys (no-keys mode): an in-memory store seeded with the demo's
 * 13 test loans. It resets when the server restarts.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfigured } from "./config";
import { DEMO_AS_OF, demoRecords } from "./demo-data";
import type { MinimalLoan } from "./plaid-map";
import { DEFAULT_SETTINGS, isPresetId, sanitizeSettings, type Connection, type PresetId, type RuleSettings, type ServicerRecord } from "./rules";

export type ItemStatus = "ok" | "login_required" | "pending_expiration" | "revoked" | "error";
export type AuditEvent = "login" | "export" | "settings_update" | "invite_created" | "plaid_connected" | "plaid_refresh" | "plaid_status";

export interface StoredItem {
  id: string;
  orgId: string;
  borrowerId: string;
  itemId: string;
  accessTokenEnc: string;
  institutionName: string | null;
  status: ItemStatus;
}

export interface InviteInfo {
  borrowerId: string;
  orgId: string;
  orgName: string;
  firstName: string;
  /** new: never connected. connected: has a live connection. reconnect: connection needs a new login. */
  state: "new" | "connected" | "reconnect";
  item: StoredItem | null;
}

export interface PendingInvite {
  name: string;
  code: string;
  createdAt: string;
}

export interface DashboardData {
  orgName: string;
  settings: RuleSettings;
  preset: PresetId;
  records: ServicerRecord[];
  pendingInvites: PendingInvite[];
  /** Demo data is fixed as of its own date; live data uses today. */
  fixedAsOf: string | null;
}

export interface Store {
  kind: "memory" | "supabase";
  getStaffOrg(userId: string): Promise<{ orgId: string; role: string } | null>;
  loadDashboard(orgId: string): Promise<DashboardData>;
  saveSettings(orgId: string, settings: RuleSettings, preset: PresetId, userId: string | null): Promise<void>;
  createInvite(orgId: string, fullName: string, email: string | null): Promise<{ code: string }>;
  getInvite(code: string): Promise<InviteInfo | null>;
  recordConsent(borrowerId: string): Promise<void>;
  saveItem(i: { orgId: string; borrowerId: string; itemId: string; accessTokenEnc: string; institutionName: string | null }): Promise<StoredItem>;
  getItem(itemId: string): Promise<StoredItem | null>;
  setItemStatus(itemId: string, status: ItemStatus, reason?: string | null): Promise<void>;
  saveLoans(item: StoredItem, loans: MinimalLoan[]): Promise<void>;
  audit(orgId: string, userId: string | null, event: AuditEvent, detail?: Record<string, unknown>): Promise<void>;
}

export const DEMO_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_INVITE_CODE = "demo-invite-0001";

export function newInviteCode(): string {
  return randomBytes(18).toString("base64url"); // 24 chars, 144 bits
}

const firstName = (full: string): string => {
  const parts = full.trim().split(/\s+/);
  return parts.includes("and") ? parts.slice(0, -1).join(" ") : parts[0] || full;
};

function connectionOf(status: ItemStatus): Connection {
  if (status === "ok") return "ok";
  if (status === "login_required") return "login_required";
  if (status === "pending_expiration") return "pending_expiration";
  return "error";
}

const n = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const v = typeof x === "number" ? x : Number(x);
  return Number.isFinite(v) ? v : null;
};
const s = (x: unknown): string | null => (typeof x === "string" && x ? x : null);

/** A stored loan row (Supabase or memory) as the rule engine's record. */
export function loanToRecord(
  row: MinimalLoan & { id: string; last_updated: string | null },
  borrower: { full_name: string; invite_email: string | null },
  item: { status: ItemStatus; institution_name: string | null },
): ServicerRecord {
  return {
    id: row.id,
    borrower: borrower.full_name,
    email: borrower.invite_email,
    servicer: row.servicer_name || item.institution_name || "Servicer not reported",
    connection: connectionOf(item.status),
    lastUpdated: row.last_updated,
    interest_rate: { percentage: n(row.interest_rate_percentage), type: s(row.interest_rate_type) },
    current_balance: n(row.current_balance),
    next_monthly_payment: n(row.next_monthly_payment),
    next_payment_due_date: s(row.next_payment_due_date),
    origination_date: s(row.origination_date),
    origination_principal_amount: n(row.origination_principal_amount),
    maturity_date: s(row.maturity_date),
    loan_term: s(row.loan_term),
    loan_type_description: s(row.loan_type_description),
    mask: s(row.account_last4),
  };
}

/* ===========================================================================
   In-memory store (no-keys mode)
   ========================================================================= */

interface MemBorrower {
  id: string;
  orgId: string;
  fullName: string;
  email: string | null;
  code: string;
  consentedAt: string | null;
  createdAt: string;
}
interface MemState {
  settings: RuleSettings;
  preset: PresetId;
  demo: ServicerRecord[];
  borrowers: MemBorrower[];
  items: StoredItem[];
  loans: Array<MinimalLoan & { id: string; itemRowId: string; borrowerId: string; last_updated: string }>;
  audit: Array<{ event: AuditEvent; at: string; detail: Record<string, unknown> }>;
}

function memState(): MemState {
  const g = globalThis as unknown as { __refiWatchMem?: MemState };
  if (!g.__refiWatchMem) {
    g.__refiWatchMem = {
      settings: { ...DEFAULT_SETTINGS },
      preset: "standard",
      demo: demoRecords(),
      borrowers: [
        { id: "demo-borrower-1", orgId: DEMO_ORG_ID, fullName: "Test Borrower", email: null, code: DEMO_INVITE_CODE, consentedAt: null, createdAt: `${DEMO_AS_OF}T12:00:00Z` },
      ],
      items: [],
      loans: [],
      audit: [],
    };
  }
  return g.__refiWatchMem;
}

const memoryStore: Store = {
  kind: "memory",
  async getStaffOrg() {
    return { orgId: DEMO_ORG_ID, role: "owner" };
  },
  async loadDashboard() {
    const st = memState();
    const live = st.loans.map((l) => {
      const b = st.borrowers.find((x) => x.id === l.borrowerId)!;
      const it = st.items.find((x) => x.id === l.itemRowId)!;
      return { ...loanToRecord(l, { full_name: b.fullName, invite_email: b.email }, { status: it.status, institution_name: it.institutionName }), isNew: true };
    });
    const pendingInvites = st.borrowers
      .filter((b) => !st.items.some((i) => i.borrowerId === b.id))
      .map((b) => ({ name: b.fullName, code: b.code, createdAt: b.createdAt }));
    return {
      orgName: "Weber Mortgage",
      settings: { ...st.settings },
      preset: st.preset,
      records: [...live, ...st.demo],
      pendingInvites,
      // Live sandbox loans would also be judged as of the demo date in this mode; fine for local testing.
      fixedAsOf: DEMO_AS_OF,
    };
  },
  async saveSettings(_orgId, settings, preset) {
    const st = memState();
    st.settings = { ...settings };
    st.preset = preset;
  },
  async createInvite(orgId, fullName, email) {
    const code = newInviteCode();
    memState().borrowers.push({ id: `mem-${code}`, orgId, fullName, email, code, consentedAt: null, createdAt: new Date().toISOString() });
    return { code };
  },
  async getInvite(code) {
    const st = memState();
    const b = st.borrowers.find((x) => x.code === code);
    if (!b) return null;
    const item = st.items.find((i) => i.borrowerId === b.id && i.status !== "revoked") || null;
    const state = !item ? "new" : item.status === "ok" ? "connected" : "reconnect";
    return { borrowerId: b.id, orgId: b.orgId, orgName: "Weber Mortgage", firstName: firstName(b.fullName), state, item };
  },
  async recordConsent(borrowerId) {
    const b = memState().borrowers.find((x) => x.id === borrowerId);
    if (b) b.consentedAt = new Date().toISOString();
  },
  async saveItem(i) {
    const st = memState();
    const existing = st.items.find((x) => x.itemId === i.itemId);
    if (existing) {
      existing.accessTokenEnc = i.accessTokenEnc;
      existing.status = "ok";
      return existing;
    }
    const item: StoredItem = { id: `mem-item-${st.items.length + 1}`, status: "ok", ...i };
    st.items.push(item);
    return item;
  },
  async getItem(itemId) {
    return memState().items.find((x) => x.itemId === itemId) || null;
  },
  async setItemStatus(itemId, status) {
    const it = memState().items.find((x) => x.itemId === itemId);
    if (it) it.status = status;
  },
  async saveLoans(item, loans) {
    const st = memState();
    const now = new Date().toISOString();
    for (const l of loans) {
      const idx = st.loans.findIndex((x) => x.itemRowId === item.id && x.plaid_account_id === l.plaid_account_id);
      const row = { ...l, id: idx >= 0 ? st.loans[idx].id : `mem-loan-${st.loans.length + 1}`, itemRowId: item.id, borrowerId: item.borrowerId, last_updated: now };
      if (idx >= 0) st.loans[idx] = row;
      else st.loans.push(row);
    }
  },
  async audit(_orgId, _userId, event, detail = {}) {
    memState().audit.push({ event, at: new Date().toISOString(), detail });
  },
};

/* ===========================================================================
   Supabase store
   ========================================================================= */

let admin: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!admin) {
    admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return admin;
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

const ITEM_COLS = "id, org_id, borrower_id, item_id, access_token_enc, institution_name, status";
type ItemRow = { id: string; org_id: string; borrower_id: string; item_id: string; access_token_enc: string; institution_name: string | null; status: ItemStatus };
const toItem = (r: ItemRow): StoredItem => ({
  id: r.id,
  orgId: r.org_id,
  borrowerId: r.borrower_id,
  itemId: r.item_id,
  accessTokenEnc: r.access_token_enc,
  institutionName: r.institution_name,
  status: r.status,
});

const LOAN_COLS =
  "id, borrower_id, plaid_item_id, plaid_account_id, servicer_name, interest_rate_percentage, interest_rate_type, current_balance, next_monthly_payment, next_payment_due_date, origination_date, origination_principal_amount, maturity_date, loan_term, loan_type_description, account_last4, last_updated";

const supabaseStore: Store = {
  kind: "supabase",
  async getStaffOrg(userId) {
    const data = check(await sb().from("staff_members").select("org_id, role").eq("user_id", userId).order("created_at").limit(1), "staff lookup");
    const row = (data as Array<{ org_id: string; role: string }>)[0];
    return row ? { orgId: row.org_id, role: row.role } : null;
  },

  async loadDashboard(orgId) {
    const [org, settings, loans, borrowers, items] = await Promise.all([
      sb().from("orgs").select("name").eq("id", orgId).single(),
      sb().from("org_settings").select("*").eq("org_id", orgId).maybeSingle(),
      sb().from("loans").select(LOAN_COLS).eq("org_id", orgId),
      sb().from("borrowers").select("id, full_name, invite_email, invite_code, created_at").eq("org_id", orgId),
      sb().from("plaid_items").select("id, borrower_id, status, institution_name").eq("org_id", orgId),
    ]);
    const orgRow = check(org, "org") as { name: string };
    const st = check(settings, "settings") as Record<string, unknown> | null;
    const loanRows = check(loans, "loans") as unknown as Array<MinimalLoan & { id: string; borrower_id: string; plaid_item_id: string; last_updated: string }>;
    const bRows = check(borrowers, "borrowers") as Array<{ id: string; full_name: string; invite_email: string | null; invite_code: string; created_at: string }>;
    const iRows = check(items, "items") as Array<{ id: string; borrower_id: string; status: ItemStatus; institution_name: string | null }>;

    const parsed = st
      ? sanitizeSettings({
          todayRate: n(st.today_rate),
          closingCosts: n(st.closing_costs),
          minDrop: n(st.min_drop),
          minSavings: n(st.min_savings),
          maxPayback: n(st.max_payback),
          minSeasoning: n(st.min_seasoning),
          newTerm: st.new_term,
          rollCosts: st.roll_costs,
        })
      : null;

    const records = loanRows
      .filter((l) => iRows.some((i) => i.id === l.plaid_item_id && i.status !== "revoked"))
      .map((l) => {
        const b = bRows.find((x) => x.id === l.borrower_id) || { full_name: "Unknown borrower", invite_email: null };
        const it = iRows.find((x) => x.id === l.plaid_item_id)!;
        return loanToRecord(l, b, it);
      })
      .sort((a, b) => a.borrower.localeCompare(b.borrower));

    // Items whose loans have not arrived yet still show, as missing data, so nothing is silently hidden.
    for (const it of iRows) {
      if (it.status === "revoked" || loanRows.some((l) => l.plaid_item_id === it.id)) continue;
      const b = bRows.find((x) => x.id === it.borrower_id);
      records.push({
        id: `item-${it.id}`,
        borrower: b?.full_name || "Unknown borrower",
        email: b?.invite_email ?? null,
        servicer: it.institution_name || "Servicer not reported",
        connection: connectionOf(it.status),
        lastUpdated: null,
        interest_rate: { percentage: null, type: null },
        current_balance: null,
        next_monthly_payment: null,
        next_payment_due_date: null,
        origination_date: null,
        origination_principal_amount: null,
        maturity_date: null,
        loan_term: null,
        loan_type_description: null,
        mask: null,
      });
    }

    const pendingInvites = bRows
      .filter((b) => !iRows.some((i) => i.borrower_id === b.id && i.status !== "revoked"))
      .map((b) => ({ name: b.full_name, code: b.invite_code, createdAt: b.created_at }));

    return {
      orgName: orgRow.name,
      settings: parsed || { ...DEFAULT_SETTINGS },
      preset: st && isPresetId(st.preset) ? st.preset : "standard",
      records,
      pendingInvites,
      fixedAsOf: null,
    };
  },

  async saveSettings(orgId, v, preset, userId) {
    check(
      await sb()
        .from("org_settings")
        .upsert({
          org_id: orgId,
          today_rate: v.todayRate,
          closing_costs: v.closingCosts,
          min_drop: v.minDrop,
          min_savings: v.minSavings,
          max_payback: v.maxPayback,
          min_seasoning: v.minSeasoning,
          new_term: v.newTerm,
          roll_costs: v.rollCosts,
          preset,
          updated_at: new Date().toISOString(),
          updated_by: userId,
        }),
      "save settings",
    );
  },

  async createInvite(orgId, fullName, email) {
    const code = newInviteCode();
    check(await sb().from("borrowers").insert({ org_id: orgId, full_name: fullName, invite_email: email, invite_code: code }), "create invite");
    return { code };
  },

  async getInvite(code) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
    const b = check(await sb().from("borrowers").select("id, org_id, full_name, orgs(name)").eq("invite_code", code).maybeSingle(), "invite") as {
      id: string;
      org_id: string;
      full_name: string;
      orgs: { name: string } | { name: string }[] | null;
    } | null;
    if (!b) return null;
    const items = check(await sb().from("plaid_items").select(ITEM_COLS).eq("borrower_id", b.id).neq("status", "revoked").limit(1), "invite item") as ItemRow[];
    const item = items[0] ? toItem(items[0]) : null;
    const orgName = Array.isArray(b.orgs) ? b.orgs[0]?.name : b.orgs?.name;
    return {
      borrowerId: b.id,
      orgId: b.org_id,
      orgName: orgName || "Weber Mortgage",
      firstName: firstName(b.full_name),
      state: !item ? "new" : item.status === "ok" ? "connected" : "reconnect",
      item,
    };
  },

  async recordConsent(borrowerId) {
    check(await sb().from("borrowers").update({ consented_at: new Date().toISOString() }).eq("id", borrowerId), "consent");
  },

  async saveItem(i) {
    const data = check(
      await sb()
        .from("plaid_items")
        .upsert(
          {
            org_id: i.orgId,
            borrower_id: i.borrowerId,
            item_id: i.itemId,
            access_token_enc: i.accessTokenEnc,
            institution_name: i.institutionName,
            status: "ok",
            status_reason: null,
          },
          { onConflict: "item_id" },
        )
        .select(ITEM_COLS)
        .single(),
      "save item",
    ) as ItemRow;
    return toItem(data);
  },

  async getItem(itemId) {
    const data = check(await sb().from("plaid_items").select(ITEM_COLS).eq("item_id", itemId).maybeSingle(), "item") as ItemRow | null;
    return data ? toItem(data) : null;
  },

  async setItemStatus(itemId, status, reason = null) {
    check(await sb().from("plaid_items").update({ status, status_reason: reason }).eq("item_id", itemId), "item status");
  },

  async saveLoans(item, loans) {
    const now = new Date().toISOString();
    if (loans.length) {
      check(
        await sb()
          .from("loans")
          .upsert(
            loans.map((l) => ({ ...l, org_id: item.orgId, borrower_id: item.borrowerId, plaid_item_id: item.id, last_updated: now })),
            { onConflict: "plaid_item_id,plaid_account_id" },
          ),
        "save loans",
      );
    }
    check(await sb().from("plaid_items").update({ last_updated_at: now, status: "ok", status_reason: null }).eq("id", item.id), "item updated");
  },

  async audit(orgId, userId, event, detail = {}) {
    // A failed audit write is logged loudly; it does not undo the action that was audited.
    const res = await sb().from("audit_log").insert({ org_id: orgId, user_id: userId, event, detail });
    if (res.error) console.error("audit_log insert failed:", res.error.message);
  },
};

export function getStore(): Store {
  return supabaseConfigured() ? supabaseStore : memoryStore;
}

/** Test hook: reset the in-memory store. */
export function resetMemoryStore(): void {
  (globalThis as unknown as { __refiWatchMem?: MemState }).__refiWatchMem = undefined;
}
