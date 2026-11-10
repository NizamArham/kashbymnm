import { useEffect, useState, useMemo, useRef } from "react";
import { PageLoader } from "../components/Loader";
import { Users, Search, Lock, Plus, Star, ChevronRight, Copy, Download, X, SlidersHorizontal, ChevronDown, ShoppingBag } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Customer } from "../lib/types";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { PageHeader, Card, Table, Th, Td, Input, Button, EmptyState, ErrorText, SortHeader, RowCard, RowCardStats, RowCardStat } from "../components/ui";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { useSortableData } from "../lib/useSortableData";
import { findCustomers, CASHIER_SEARCH_MIN_CHARS } from "../lib/customerSearch";
import { useAdminApproval } from "../components/AdminApproval";
import { formatDate } from "../lib/dates";
import { whatsappNumber } from "../lib/phone";
import { useToast } from "../components/Feedback";

type CustomerSortKey = "priority" | "code" | "name" | "phone" | "loyalty" | "balance" | "last_order";
// What the Filter ticks mean. Ticks in the same group are "either" (Owes me + Has store credit shows both kinds of people); ticks in
// different groups all have to fit (Owes me + Ladies = the ladies who owe).
type BalanceKey = "owes" | "credit";
const BALANCE_OPTIONS: { value: BalanceKey; label: string; hint: string }[] = [
  { value: "owes", label: "Owes me", hint: "Customers with a balance to pay" },
  { value: "credit", label: "Has store credit", hint: "Customers with store credit to spend" },
];
// Ladies / Men's, for finding the right people to tell about something (the stored values are female / male).
type WhoKey = "female" | "male" | "unspecified";
const WHO_OPTIONS: { value: WhoKey; label: string }[] = [
  { value: "female", label: "Ladies" },
  { value: "male", label: "Men's" },
  { value: "unspecified", label: "Not set" },
];
type Picks = { balance: BalanceKey[]; inactive: boolean; who: WhoKey[] };

// A phone as the +94… number WhatsApp and phone books want.
const fullNumber = (stored: string) => `+${whatsappNumber(stored)}`;

// One .vcf file holding everyone — open it on a phone (or import it into Contacts) and they all land in the address book, ready to pick
// for a WhatsApp broadcast list.
function vcardOf(people: { name: string; phone: string }[]): string {
  const clean = (t: string) => t.replace(/[\\;,]/g, " ").replace(/\s+/g, " ").trim();
  return people.map((c) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${clean(c.name)}\r\nTEL;TYPE=CELL:${fullNumber(c.phone)}\r\nEND:VCARD\r\n`).join("");
}
const INACTIVE_AFTER_DAYS = 60;
function isInactive(c: Customer): boolean {
  if (!c.last_order_date) return true;
  const last = new Date(c.last_order_date.slice(0, 10) + "T00:00:00").getTime();
  return Number.isNaN(last) || Date.now() - last > INACTIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}
// Find a customer; clicking one opens their page (/customers/<id>), which is where everything about them lives.
// A filter that is switched on, as a small tag you can take off.
function FilterTag({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 py-1 pl-3 pr-1.5 text-xs font-medium text-gray-800">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove filter: ${label}`} className="rounded-full p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-900">
        <X size={12} />
      </button>
    </span>
  );
}

// One tick box in the Filter drop-down, with how many people it would show.
function FilterTick({ checked, count, title, onChange, children }: { checked: boolean; count: number; title?: string; onChange: () => void; children: React.ReactNode }) {
  return (
    <label title={title} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm text-gray-800 hover:bg-gray-50">
      <input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 rounded border-gray-300 accent-black" />
      <span className="flex-1">{children}</span>
      <span className="text-xs tabular-nums text-gray-500">{count}</span>
    </label>
  );
}

export default function ViewCustomersPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // A cashier can look up "who owes" only with an admin's password typed at the till, once per look.
  const { runWithApproval } = useAdminApproval();
  const [showingCredit, setShowingCredit] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The ticks in the Filter drop-down (admin only).
  const [balanceSel, setBalanceSel] = useState<BalanceKey[]>([]);
  const [inactiveOnly, setInactiveOnly] = useState(false);
  const [whoSel, setWhoSel] = useState<WhoKey[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  // The one search bar also finds people by what they bought: with "Bought item" on, what's typed is an item, brand or category, and the
  // list narrows to the people who bought something matching it (null = not filtering by it).
  const [searchBought, setSearchBought] = useState(false);
  const boughtText = searchBought ? query : "";
  const [bought, setBought] = useState<{ ids: Set<number>; products: number } | null>(null);
  const [boughtError, setBoughtError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useKeyboardShortcut("/", () => searchInputRef.current?.focus());

  // An old /customers?open=12 link goes straight to that customer's page.
  useEffect(() => {
    const openId = Number(searchParams.get("open"));
    if (openId) navigate(`/customers/${openId}`, { replace: true });
  }, [searchParams, navigate]);

  // An admin sees everyone. A cashier sees nobody until they type a customer's FULL name or phone number
  // (the server only answers an exact match), so there is no list to browse or read off the screen.
  async function load() {
    setLoading(true);
    try {
      if (isAdmin) setCustomers(await api.get<Customer[]>("/customers"));
      else if (showingCredit) {
        // The credit list was unlocked once; refreshing it just re-reads those same people — no second password.
        const again = await Promise.all(customers.map((c) => api.get<Customer>(`/customers/${c.id}`)));
        setCustomers(again.filter((c) => c.balance_due > 0));
      } else setCustomers(query.trim().length >= CASHIER_SEARCH_MIN_CHARS ? await findCustomers(query) : []);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load customers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A cashier's search: a beat after the last keystroke (Enter doesn't wait). Part of a name or number
  // (3+ characters) brings up a few people at most — there is no list to browse.
  const exactSearchSeq = useRef(0);
  function searchExactly(text: string) {
    const seq = ++exactSearchSeq.current;
    const q = text.trim();
    if (q.length < CASHIER_SEARCH_MIN_CHARS) {
      setCustomers([]);
      return;
    }
    findCustomers(q)
      .then((found) => {
        if (seq === exactSearchSeq.current) setCustomers(found);
      })
      .catch(() => {
        if (seq === exactSearchSeq.current) setCustomers([]);
      });
  }
  // Only typing starts a search.
  const userTyped = useRef(false);
  // "Credit customers": who owes money, for a cashier — a one-time look, after an admin types their password.
  async function showCreditCustomers() {
    setError(null);
    try {
      const owing = await runWithApproval((approval) => api.get<Customer[]>("/customers?owing=1", { approval }));
      exactSearchSeq.current++;
      userTyped.current = false;
      setQuery("");
      setShowingCredit(true);
      setCustomers(owing);
      if (sortKey !== "balance") toggleSort("balance"); // most owing first (their balance is the most negative)
    } catch (err) {
      // A cancelled password prompt just leaves things as they were.
      if (!(err instanceof ApiRequestError && err.code === "needs_approval")) {
        setError(err instanceof ApiRequestError ? err.message : "Couldn't load the credit customers");
      }
    }
  }
  function hideCreditCustomers() {
    if (sortKey === "balance") toggleSort("name");
    setShowingCredit(false);
    setCustomers([]);
  }

  useEffect(() => {
    if (isAdmin || !userTyped.current) return;
    const timer = window.setTimeout(() => searchExactly(query), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isAdmin]);

  useEffect(() => {
    const text = boughtText.trim();
    if (!isAdmin || text.length < 2) {
      setBought(null);
      setBoughtError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .get<{ customer_ids: number[]; matching_products: number }>(`/customers/bought?q=${encodeURIComponent(text)}`)
        .then((r) => {
          if (cancelled) return;
          setBought({ ids: new Set(r.customer_ids), products: r.matching_products });
          setBoughtError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setBought(null);
          setBoughtError(err instanceof ApiRequestError ? err.message : "Couldn't look that up");
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [boughtText, isAdmin]);

  const filteredCustomers = useMemo(() => {
    // A cashier's list already is the exact match the server found (a typed "0771234567" is a stored
    // "771234567"), so it isn't filtered again here.
    if (!isAdmin) return customers;
    const trimmed = query.trim().toLowerCase();
    if (!trimmed || searchBought) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(trimmed) ||
        c.customer_code.toLowerCase().includes(trimmed) ||
        c.phone?.toLowerCase().includes(trimmed) ||
        c.phone2?.toLowerCase().includes(trimmed)
    );
  }, [customers, query, isAdmin, searchBought]);

  // The list narrowed by the ticks, and how many people each tick would show with the others as they are (a tick counts people in its
  // own group on its own, so "Ladies 13" stays 13 even with "Men's" ticked).
  const picks: Picks = { balance: balanceSel, inactive: inactiveOnly, who: whoSel };
  const passes = (c: Customer, p: Picks) =>
    (p.balance.length === 0 || p.balance.some((k) => (k === "owes" ? (c.balance_due ?? 0) > 0 : (c.store_credit_balance ?? 0) > 0))) &&
    (!p.inactive || isInactive(c)) &&
    (p.who.length === 0 || p.who.includes(c.gender as WhoKey)) &&
    (!bought || bought.ids.has(c.id));
  const tickCounts = useMemo(() => {
    const counts = { owes: 0, credit: 0, inactive: 0, female: 0, male: 0, unspecified: 0 };
    for (const c of filteredCustomers) {
      for (const k of ["owes", "credit"] as const) if (passes(c, { ...picks, balance: [k] })) counts[k]++;
      if (passes(c, { ...picks, inactive: true })) counts.inactive++;
      for (const k of ["female", "male", "unspecified"] as const) if (passes(c, { ...picks, who: [k] })) counts[k]++;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredCustomers, balanceSel, inactiveOnly, whoSel, bought]);
  const segmentCustomers = useMemo(
    () => (isAdmin ? filteredCustomers.filter((c) => passes(c, picks)) : filteredCustomers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredCustomers, balanceSel, inactiveOnly, whoSel, bought, isAdmin]
  );
  const owedTotal = useMemo(() => segmentCustomers.reduce((sum, c) => sum + Math.max(0, c.balance_due ?? 0), 0), [segmentCustomers]);
  const creditTotal = useMemo(() => segmentCustomers.reduce((sum, c) => sum + Math.max(0, c.store_credit_balance ?? 0), 0), [segmentCustomers]);

  // Default order (sortKey "priority"), most actionable first:
  //   1. Pending  — customer owes money (balance_due > 0)
  //   2. Overpaid — has store credit and no debt
  //   3. Settled  — nothing outstanding either way
  // Clicking any column header overrides this with a plain sort on
  // that column, same as every other sortable table.
  function tier(c: Customer): number {
    if ((c.balance_due ?? 0) > 0) return 0; // pending — owes us money
    if ((c.store_credit_balance ?? 0) > 0) return 1; // overpaid — we owe them credit
    return 2; // settled
  }

  const { sorted: sortedCustomers, sortKey, sortDir, toggleSort, setSort } = useSortableData<Customer, CustomerSortKey>(
    segmentCustomers,
    (c, key) => {
      switch (key) {
        case "priority":
          return tier(c);
        case "code":
          return c.customer_code.toLowerCase();
        case "name":
          return c.name.toLowerCase();
        case "phone":
          return (c.phone ?? "").toLowerCase();
        case "loyalty":
          return c.loyalty_points;
        case "balance":
          return (c.store_credit_balance ?? 0) - (c.balance_due ?? 0);
        case "last_order":
          return c.last_order_date ?? "";
      }
    },
    // Most-owing first is an admin's view; a cashier's list just goes by name.
    isAdmin ? "priority" : "name"
  );

  // The people showing right now, as contacts: the number WhatsApp wants, one per line / one card each in a .vcf.
  const contacts = useMemo(
    () => sortedCustomers.filter((c) => !!c.phone).map((c) => ({ name: c.name, phone: c.phone as string })),
    [sortedCustomers]
  );
  async function copyNumbers() {
    const text = contacts.map((c) => fullNumber(c.phone)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${contacts.length} number${contacts.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Couldn't copy — allow clipboard access for this page and try again");
    }
  }
  function downloadContacts() {
    const label = [...WHO_OPTIONS.filter((w) => whoSel.includes(w.value)).map((w) => w.label), boughtText.trim() && `bought ${boughtText.trim()}`].filter(Boolean).join(" ") || "customers";
    const url = URL.createObjectURL(new Blob([vcardOf(contacts)], { type: "text/vcard" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-contacts.vcf`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${contacts.length} contact${contacts.length === 1 ? "" : "s"} — open the file on your phone to add them`);
  }

  // How many ticks are on, and the ways of changing them.
  const activeFilters = balanceSel.length + (inactiveOnly ? 1 : 0) + whoSel.length;
  // Each kind of list has the order you'd want: biggest debt first, most credit first, longest quiet first.
  function sortFor(balance: BalanceKey[], inactive: boolean) {
    if (balance.length === 1 && balance[0] === "owes") setSort("balance", "asc");
    else if (balance.length === 1 && balance[0] === "credit") setSort("balance", "desc");
    else if (balance.length === 0 && inactive) setSort("last_order", "asc");
    else setSort("priority", "asc");
  }
  const flip = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  function toggleBalance(k: BalanceKey) {
    const next = flip(balanceSel, k);
    setBalanceSel(next);
    sortFor(next, inactiveOnly);
  }
  function toggleInactive() {
    setInactiveOnly(!inactiveOnly);
    sortFor(balanceSel, !inactiveOnly);
  }
  function clearFilters() {
    setBalanceSel([]);
    setInactiveOnly(false);
    setWhoSel([]);
    setSort("priority", "asc");
  }
  // The drop-down closes when you click anywhere else, or press Escape.
  useEffect(() => {
    if (!filtersOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFiltersOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFiltersOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [filtersOpen]);

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Click any customer to open their page."
        action={
          <Button variant="primary" onClick={() => navigate("/customers/add")} className="inline-flex items-center gap-1.5">
            <Plus size={16} />
            Add customer
          </Button>
        }
      />

      <Card className="mb-5">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
            {isAdmin && searchBought ? <ShoppingBag size={16} className="text-gray-700" /> : <Search size={16} className="text-gray-400" />}
          </div>
          <Input
            ref={searchInputRef}
            className={isAdmin ? "pl-10 pr-36" : "pl-10"}
            placeholder={isAdmin ? (searchBought ? "An item, brand or category, e.g. leggings" : "Search customers...") : "Type part of a name, or a phone number..."}
            value={query}
            onChange={(e) => {
              userTyped.current = true;
              if (showingCredit && sortKey === "balance") toggleSort("name");
              setShowingCredit(false);
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isAdmin) searchExactly(query);
            }}
          />
          {/* One bar for both: by default it finds a customer; switched on, the same bar finds who bought an item. */}
          {isAdmin && (
            <button
              type="button"
              aria-pressed={searchBought}
              onClick={() => {
                setSearchBought((on) => !on);
                searchInputRef.current?.focus();
              }}
              title={searchBought ? "Searching by what they bought — click to search by name, code or phone again" : "Search by what they bought, instead of by name"}
              className={`absolute inset-y-0 right-2 my-auto inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition ${
                searchBought ? "bg-black text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              <ShoppingBag size={13} />
              Bought item
            </button>
          )}
        </div>
        {!isAdmin && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-gray-500">
              {showingCredit ? "Customers who owe money, most owing first." : "Showing up to 5 people at a time."}
            </p>
            {showingCredit ? (
              <Button size="sm" onClick={hideCreditCustomers}>
                Hide the list
              </Button>
            ) : (
              <Button size="sm" onClick={showCreditCustomers} className="inline-flex items-center gap-1.5" title="Needs an admin's password">
                <Lock size={13} />
                Credit customers
              </Button>
            )}
          </div>
        )}
      </Card>

      {isAdmin && !loading && customers.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative" ref={filterRef}>
              <Button size="sm" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-haspopup="true" className="inline-flex items-center gap-1.5">
                <SlidersHorizontal size={14} />
                Filter
                {activeFilters > 0 && <span className="rounded-full bg-black px-1.5 text-xs font-medium text-white">{activeFilters}</span>}
                <ChevronDown size={13} className={`text-gray-500 transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
              </Button>
              {filtersOpen && (
                <div role="group" aria-label="Filter customers" className="absolute left-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
                  <p className="px-2 pb-1 pt-1.5 text-xs font-medium text-gray-500">Balance</p>
                  {BALANCE_OPTIONS.map((o) => (
                    <FilterTick key={o.value} checked={balanceSel.includes(o.value)} count={tickCounts[o.value]} title={o.hint} onChange={() => toggleBalance(o.value)}>
                      {o.label}
                    </FilterTick>
                  ))}
                  <p className="px-2 pb-1 pt-3 text-xs font-medium text-gray-500">Last order</p>
                  <FilterTick checked={inactiveOnly} count={tickCounts.inactive} title="No order in the last 60 days, or never" onChange={toggleInactive}>
                    Not ordered in 60 days
                  </FilterTick>
                  <p className="px-2 pb-1 pt-3 text-xs font-medium text-gray-500">Who</p>
                  {WHO_OPTIONS.filter((w) => w.value !== "unspecified" || customers.some((c) => c.gender === "unspecified")).map((w) => (
                    <FilterTick key={w.value} checked={whoSel.includes(w.value)} count={tickCounts[w.value]} onChange={() => setWhoSel(flip(whoSel, w.value))}>
                      {w.label}
                    </FilterTick>
                  ))}
                  {activeFilters > 0 && (
                    <div className="mt-2 border-t border-gray-100 px-2 pt-2">
                      <button type="button" onClick={clearFilters} className="text-xs text-gray-500 underline hover:text-gray-800">
                        Clear all ticks
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* What is ticked, each one removable on the spot. */}
            {BALANCE_OPTIONS.filter((o) => balanceSel.includes(o.value)).map((o) => (
              <FilterTag key={o.value} label={o.label} onRemove={() => toggleBalance(o.value)} />
            ))}
            {inactiveOnly && <FilterTag label="Not ordered in 60 days" onRemove={toggleInactive} />}
            {WHO_OPTIONS.filter((w) => whoSel.includes(w.value)).map((w) => (
              <FilterTag key={w.value} label={w.label} onRemove={() => setWhoSel(flip(whoSel, w.value))} />
            ))}
            {activeFilters > 1 && (
              <button type="button" onClick={clearFilters} className="text-xs text-gray-500 underline hover:text-gray-800">
                Clear all
              </button>
            )}
            {segmentCustomers.length > 0 && contacts.length > 0 && (
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" onClick={copyNumbers} className="inline-flex items-center gap-1.5" title="Copy these phone numbers, one per line, in +94… form">
                  <Copy size={13} />
                  Copy numbers
                </Button>
                <Button size="sm" onClick={downloadContacts} className="inline-flex items-center gap-1.5" title="A contacts file: open it on your phone to add them all, then pick them for a WhatsApp broadcast list">
                  <Download size={13} />
                  Contacts file
                </Button>
              </div>
            )}
          </div>

          {boughtError && <p className="mb-3 text-xs text-red-600">{boughtError}</p>}
          {searchBought && query.trim().length < 2 && <p className="mb-3 text-xs text-gray-500">Type an item, brand or category (2 letters or more) to see who bought it.</p>}
          {bought && (
            <p className="mb-3 text-xs text-gray-500">
              {bought.ids.size === 0
                ? bought.products === 0
                  ? `No product, brand or category matches "${boughtText.trim()}".`
                  : `${bought.products} product${bought.products === 1 ? "" : "s"} match "${boughtText.trim()}", but nobody has bought ${bought.products === 1 ? "it" : "them"} yet.`
                : `${bought.ids.size} customer${bought.ids.size === 1 ? "" : "s"} bought something matching "${boughtText.trim()}" (${bought.products} product${bought.products === 1 ? "" : "s"}).`}
            </p>
          )}
          {segmentCustomers.length > 0 && (
            <p className="mb-3 text-xs text-gray-500">
              Showing {segmentCustomers.length} {segmentCustomers.length === 1 ? "person" : "people"}
              {contacts.length !== segmentCustomers.length && ` · ${contacts.length} with a phone number`}
            </p>
          )}
          {balanceSel.includes("owes") && segmentCustomers.length > 0 && (
            <p className="mb-3 text-xs text-gray-500">
              {segmentCustomers.length} customer{segmentCustomers.length === 1 ? " owes" : "s owe"} <span className="font-medium text-red-600">Rs. {owedTotal.toLocaleString()}</span> in total
            </p>
          )}
          {balanceSel.includes("credit") && segmentCustomers.length > 0 && (
            <p className="mb-3 text-xs text-gray-500">
              {segmentCustomers.length} customer{segmentCustomers.length === 1 ? " holds" : "s hold"} <span className="font-medium text-green-700">Rs. {creditTotal.toLocaleString()}</span> in store credit
            </p>
          )}
        </>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <PageLoader />
      ) : segmentCustomers.length === 0 ? (
        isAdmin ? (
          <EmptyState
            icon={Users}
            title={
              query && !searchBought
                ? "No matching customers"
                : bought || activeFilters > 0
                ? activeFilters === 1 && !bought
                  ? balanceSel[0] === "owes"
                    ? "Nobody owes you anything right now"
                    : balanceSel[0] === "credit"
                    ? "No customer has store credit"
                    : inactiveOnly
                    ? "Everyone has ordered recently"
                    : "Nobody fits that filter"
                  : "Nobody fits all of those filters"
                : "No customers yet"
            }
            actions={
              query && !searchBought
                ? [{ label: "Clear search", onClick: () => setQuery("") }]
                : bought || activeFilters > 0
                ? [
                    {
                      label: activeFilters === 1 && !bought ? "Show all customers" : "Clear the filters",
                      onClick: () => {
                        clearFilters();
                        if (searchBought) setQuery("");
                      },
                    },
                  ]
                : [{ label: "Add customer", primary: true, onClick: () => navigate("/customers/add") }]
            }
          />
        ) : (
          <EmptyState
            icon={Users}
            title={showingCredit ? "Nobody owes anything right now" : query.trim().length >= CASHIER_SEARCH_MIN_CHARS ? "No customer found" : "Find a customer"}
            subtitle={
              showingCredit
                ? undefined
                : query.trim().length >= CASHIER_SEARCH_MIN_CHARS
                ? "Check the spelling, or try their phone number."
                : "Type part of their name, or their phone number, above."
            }
            actions={showingCredit || query.trim().length < CASHIER_SEARCH_MIN_CHARS ? undefined : [{ label: "Add as a new customer", primary: true, onClick: () => navigate("/customers/add") }]}
          />
        )
      ) : (
        <>
        {/* Desktop / tablet-landscape */}
        <Card className="p-0 overflow-clip hidden lg:block">
          <Table>
            <thead>
              <tr>
                <SortHeader<CustomerSortKey> label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<CustomerSortKey> label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<CustomerSortKey> label="Phone" sortKey="phone" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<CustomerSortKey> label="Loyalty points" sortKey="loyalty" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                {/* A customer's balance is for admins in the list; a cashier sees it once that customer is opened. */}
                {(isAdmin || showingCredit) && <SortHeader<CustomerSortKey> label="Balance" sortKey="balance" activeKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />}
                <SortHeader<CustomerSortKey> label="Last order" sortKey="last_order" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {sortedCustomers.map((c) => {
                const netBalance = (c.store_credit_balance ?? 0) - (c.balance_due ?? 0);
                return (
                  <tr key={c.id} data-customer-row={c.id} onClick={() => navigate(`/customers/${c.id}`)} className="cursor-pointer hover:bg-gray-50">
                    <Td>{c.customer_code}</Td>
                    <Td className="font-medium">
                      {c.name}
                      {c.is_suspended === 1 && <span className="ml-1.5 text-xs font-normal text-red-600">(suspended)</span>}
                    </Td>
                    <Td>{c.phone ?? "—"}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1">
                        <Star size={12} className="text-amber-400" />
                        {c.loyalty_points}
                      </span>
                    </Td>
                    {(isAdmin || showingCredit) && (
                      <Td align="right" className={netBalance < 0 ? "text-red-600 font-medium" : netBalance > 0 ? "text-green-700 font-medium" : ""}>
                        {netBalance === 0 ? "—" : netBalance > 0 ? `+Rs. ${netBalance.toLocaleString()}` : `-Rs. ${Math.abs(netBalance).toLocaleString()}`}
                      </Td>
                    )}
                    <Td>{c.last_order_date ? formatDate(c.last_order_date) : "—"}</Td>
                    <Td className="w-8 text-right">
                      <ChevronRight size={14} className="text-gray-300" />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>

        {/* Phone / tablet-portrait: one card per customer, so nothing is squeezed or scrolls sideways */}
        <div className="lg:hidden space-y-2.5">
          {sortedCustomers.map((c) => {
            const netBalance = (c.store_credit_balance ?? 0) - (c.balance_due ?? 0);
            return (
              <RowCard key={c.id} onClick={() => navigate(`/customers/${c.id}`)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 leading-snug">
                      {c.name}
                      {c.is_suspended === 1 && <span className="ml-1.5 text-xs font-normal text-red-600">(suspended)</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {c.customer_code}
                      {c.phone ? ` · ${c.phone}` : ""}
                    </p>
                  </div>
                  <ChevronRight size={16} className="mt-0.5 flex-shrink-0 text-gray-300" />
                </div>
                <RowCardStats>
                  {(isAdmin || showingCredit) && (
                    <RowCardStat
                      label="Balance"
                      value={
                        <span className={netBalance < 0 ? "text-red-600" : netBalance > 0 ? "text-green-700" : ""}>
                          {netBalance === 0 ? "—" : netBalance > 0 ? `+Rs. ${netBalance.toLocaleString()}` : `-Rs. ${Math.abs(netBalance).toLocaleString()}`}
                        </span>
                      }
                    />
                  )}
                  <RowCardStat
                    label="Points"
                    value={
                      <span className="inline-flex items-center gap-1">
                        <Star size={12} className="text-amber-400" />
                        {c.loyalty_points}
                      </span>
                    }
                  />
                  <RowCardStat label="Last order" value={c.last_order_date ? formatDate(c.last_order_date) : "—"} />
                </RowCardStats>
              </RowCard>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
