import { useEffect, useState, useMemo, useRef } from "react";
import { PageLoader } from "../components/Loader";
import { Users, Search, Lock, Plus, Star, ChevronRight, Copy, Download, X } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Customer } from "../lib/types";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { PageHeader, Card, Table, Th, Td, Input, Button, EmptyState, ErrorText, SortHeader, RowCard, RowCardStats, RowCardStat, Badge } from "../components/ui";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { useSortableData } from "../lib/useSortableData";
import { findCustomers, CASHIER_SEARCH_MIN_CHARS } from "../lib/customerSearch";
import { useAdminApproval } from "../components/AdminApproval";
import { formatDate } from "../lib/dates";
import { whatsappNumber } from "../lib/phone";
import { useToast } from "../components/Feedback";

type CustomerSortKey = "priority" | "code" | "name" | "phone" | "loyalty" | "balance" | "last_order";
// The groups an admin can narrow the list to.
type Segment = "all" | "owes" | "credit" | "inactive";
const SEGMENTS: { value: Segment; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Every customer" },
  { value: "owes", label: "Owes me", hint: "Customers with a balance to pay" },
  { value: "credit", label: "Has credit", hint: "Customers with store credit to spend" },
  { value: "inactive", label: "Inactive", hint: "No order in the last 60 days (or never)" },
];
// Ladies / Men's, for finding the right people to tell about something (the stored values are female / male).
type GenderFilter = "all" | "female" | "male" | "unspecified";
const GENDERS: { value: GenderFilter; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "female", label: "Ladies" },
  { value: "male", label: "Men's" },
  { value: "unspecified", label: "Not set" },
];
const genderLabel = (g: string | null | undefined) => (g === "female" ? "Ladies" : g === "male" ? "Men's" : null);

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
const inSegment = (c: Customer, segment: Segment): boolean =>
  segment === "all" ||
  (segment === "owes" && (c.balance_due ?? 0) > 0) ||
  (segment === "credit" && (c.store_credit_balance ?? 0) > 0) ||
  (segment === "inactive" && isInactive(c));

// Find a customer; clicking one opens their page (/customers/<id>), which is where everything about them lives.
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
  const [segment, setSegment] = useState<Segment>("all");
  const [gender, setGender] = useState<GenderFilter>("all");
  const toast = useToast();
  // "Bought before": what was typed, and the people who bought something matching it (null = not filtering by it).
  const [boughtText, setBoughtText] = useState("");
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
    if (!trimmed) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(trimmed) ||
        c.customer_code.toLowerCase().includes(trimmed) ||
        c.phone?.toLowerCase().includes(trimmed) ||
        c.phone2?.toLowerCase().includes(trimmed)
    );
  }, [customers, query, isAdmin]);

  // How many of the searched list fall in each group, and the list narrowed to the chosen one (admin only).
  // Every filter narrows the same list, and each chip's count follows the other filters: with "Ladies" on, "Owes me" counts the ladies who owe.
  const passes = (c: Customer, seg: Segment, g: GenderFilter) =>
    inSegment(c, seg) && (g === "all" || c.gender === g) && (!bought || bought.ids.has(c.id));
  const segmentCounts = useMemo(() => {
    const counts: Record<Segment, number> = { all: 0, owes: 0, credit: 0, inactive: 0 };
    for (const c of filteredCustomers) for (const seg of SEGMENTS) if (passes(c, seg.value, gender)) counts[seg.value]++;
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredCustomers, gender, bought]);
  const genderCounts = useMemo(() => {
    const counts: Record<GenderFilter, number> = { all: 0, female: 0, male: 0, unspecified: 0 };
    for (const c of filteredCustomers) {
      if (!passes(c, segment, "all")) continue;
      counts.all++;
      counts[c.gender as GenderFilter]++;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredCustomers, segment, bought]);
  const segmentCustomers = useMemo(
    () => (isAdmin ? filteredCustomers.filter((c) => passes(c, segment, gender)) : filteredCustomers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredCustomers, segment, gender, bought, isAdmin]
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
    const label = [genderLabel(gender), boughtText.trim() && `bought ${boughtText.trim()}`].filter(Boolean).join(" ") || "customers";
    const url = URL.createObjectURL(new Blob([vcardOf(contacts)], { type: "text/vcard" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-contacts.vcf`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${contacts.length} contact${contacts.length === 1 ? "" : "s"} — open the file on your phone to add them`);
  }

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
            <Search size={16} className="text-gray-400" />
          </div>
          <Input
            ref={searchInputRef}
            className="pl-10"
            placeholder={isAdmin ? "Search customers..." : "Type part of a name, or a phone number..."}
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
            {SEGMENTS.map((seg) => {
              const active = segment === seg.value;
              return (
                <button
                  key={seg.value}
                  title={seg.hint}
                  onClick={() => {
                    setSegment(seg.value);
                    // Each group has the order you'd want: biggest debt first, most credit first, longest quiet first.
                    if (seg.value === "owes") setSort("balance", "asc");
                    else if (seg.value === "credit") setSort("balance", "desc");
                    else if (seg.value === "inactive") setSort("last_order", "asc");
                    else setSort("priority", "asc");
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${
                    active ? "bg-black text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {seg.label}
                  <span className={`text-xs tabular-nums ${active ? "text-white/70" : "text-gray-400"}`}>{segmentCounts[seg.value]}</span>
                </button>
              );
            })}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {GENDERS.filter((g) => g.value !== "unspecified" || customers.some((c) => c.gender === "unspecified")).map((g) => {
              const active = gender === g.value;
              return (
                <button
                  key={g.value}
                  onClick={() => setGender(g.value)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${
                    active ? "bg-black text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {g.label}
                  <span className={`text-xs tabular-nums ${active ? "text-white/70" : "text-gray-400"}`}>{genderCounts[g.value]}</span>
                </button>
              );
            })}
            <div className="relative ml-1 w-full sm:w-64">
              <Input
                value={boughtText}
                onChange={(e) => setBoughtText(e.target.value)}
                placeholder="Bought before… e.g. leggings"
                aria-label="Only people who bought this before"
                className="!py-1.5 !pr-8"
              />
              {boughtText && (
                <button
                  type="button"
                  onClick={() => setBoughtText("")}
                  aria-label="Clear"
                  className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-700"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
          {boughtError && <p className="mb-3 text-xs text-red-600">{boughtError}</p>}
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
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-gray-500">
                Showing {segmentCustomers.length} {segmentCustomers.length === 1 ? "person" : "people"}
                {contacts.length !== segmentCustomers.length && ` · ${contacts.length} with a phone number`}
              </p>
              {contacts.length > 0 && (
                <div className="flex items-center gap-2">
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
          )}
          {segment === "owes" && segmentCustomers.length > 0 && (
            <p className="mb-3 text-xs text-gray-500">
              {segmentCustomers.length} customer{segmentCustomers.length === 1 ? "" : "s"} owe <span className="font-medium text-red-600">Rs. {owedTotal.toLocaleString()}</span> in total
            </p>
          )}
          {segment === "credit" && segmentCustomers.length > 0 && (
            <p className="mb-3 text-xs text-gray-500">
              {segmentCustomers.length} customer{segmentCustomers.length === 1 ? "" : "s"} hold <span className="font-medium text-green-700">Rs. {creditTotal.toLocaleString()}</span> in store credit
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
              query
                ? "No matching customers"
                : bought || gender !== "all"
                ? "Nobody fits all of those filters"
                : segment === "owes"
                ? "Nobody owes you anything right now"
                : segment === "credit"
                ? "No customer has store credit"
                : segment === "inactive"
                ? "Everyone has ordered recently"
                : "No customers yet"
            }
            actions={
              query
                ? [{ label: "Clear search", onClick: () => setQuery("") }]
                : bought || gender !== "all"
                ? [
                    { label: "Clear the filters", onClick: () => { setGender("all"); setBoughtText(""); setSegment("all"); } },
                  ]
                : segment !== "all"
                ? [{ label: "Show all customers", onClick: () => setSegment("all") }]
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
                      {isAdmin && genderLabel(c.gender) && (
                        <span className="ml-2 align-middle">
                          <Badge label={genderLabel(c.gender)!} />
                        </span>
                      )}
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
                      {isAdmin && genderLabel(c.gender) ? ` · ${genderLabel(c.gender)}` : ""}
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
