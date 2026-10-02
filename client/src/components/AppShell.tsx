import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import {
  Home,
  Package,
  ShoppingCart,
  Users,
  History,
  RotateCcw,
  Truck,
  Landmark,
  Search,
  Plus,
  Settings,
  ChevronDown,
  ChevronRight,
  LogOut,
  Menu,
  X,
  ShoppingBag,
  FolderOpen,
  CreditCard,
  UserCog,
  SlidersHorizontal,
  Clock,
  Banknote,
  PackageCheck,
  Send,
  LayoutGrid,
  BarChart3,
  ClipboardList,
  Tag,
  FileText,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";

interface MenuSubItem {
  id: string;
  label: string;
  path: string;
  icon: any;
  adminOnly?: boolean;
}

interface MenuItem {
  id: string;
  label: string;
  path: string;
  icon: any;
  adminOnly?: boolean;
  subItems?: MenuSubItem[];
}

export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const isAdmin = user?.role === "admin";

  // Accordion — only one section's sub-items are ever open at a time.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The nav list scrolls on its own (flex-1 overflow-y-auto) — at common
  // shorter window heights (e.g. 1024x768, right where the sidebar first
  // switches on), the full item list plus an expanded section's sub-items
  // can be taller than that scroll area. Without this, whichever section
  // just opened can land entirely below the fold with no scrollbar shown
  // and no hint it's there — General Settings under Admin was exactly
  // this case. Scrolling the newly-opened section into view keeps it
  // reachable without the user needing to discover the scroll on their own.
  const menuItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const menu: MenuItem[] = [
    { id: "dashboard", label: "Dashboard", icon: Home, path: "/" },
    { id: "find", label: "Find", icon: Search, path: "/find", adminOnly: true },
    { id: "analytics", label: "Analytics", icon: BarChart3, path: "/analytics", adminOnly: true },
    {
      id: "pos",
      label: "POS",
      icon: ShoppingCart,
      path: "/pos",
      subItems: [
        { id: "checkout", label: "Checkout", path: "/pos", icon: ShoppingCart },
        { id: "sales-history", label: "Sale History", path: "/sales", icon: History },
        { id: "quotations", label: "Quotations", path: "/quotations", icon: FileText },
        { id: "promotions", label: "Promotions", path: "/promotions", icon: Tag, adminOnly: true },
      ],
    },
    {
      id: "inventory",
      label: "Inventory",
      icon: Package,
      path: "/inventory",
      subItems: [
        { id: "stocks", label: "Stocks", path: "/inventory", icon: LayoutGrid },
        { id: "manage-products", label: "Manage Products", path: "/products", icon: Settings, adminOnly: true },
        { id: "add-product", label: "Add Product", path: "/products/add", icon: Plus, adminOnly: true },
      ],
    },
    {
      id: "directory",
      label: "Directory",
      icon: FolderOpen,
      path: "/customers",
      subItems: [
        { id: "view-customers", label: "Customers", path: "/customers", icon: Users },
        { id: "staff", label: "Staff", path: "/staff", icon: UserCog, adminOnly: true },
        { id: "suppliers", label: "Suppliers", path: "/suppliers", icon: Truck, adminOnly: true },
      ],
    },
    {
      id: "returns",
      label: "Returns",
      icon: RotateCcw,
      path: "/returns",
    },
    {
      id: "purchases",
      label: "Purchases",
      icon: Package,
      path: "/purchases",
      adminOnly: true,
      subItems: [
        { id: "purchases", label: "Purchases", path: "/purchases", icon: Package },
        { id: "supplier-payments", label: "Supplier Payments", path: "/supplier-payments", icon: CreditCard },
      ],
    },
    {
      id: "finance",
      label: "Finance",
      icon: Landmark,
      path: "/cash-book",
      adminOnly: true,
      subItems: [
        { id: "cash-book", label: "Cash Book", path: "/cash-book", icon: Landmark },
        { id: "cheques", label: "Cheques", path: "/cheques", icon: Banknote },
      ],
    },
    {
      id: "deliveries",
      label: "Shipments",
      icon: Truck,
      path: "/deliveries",
      subItems: [
        { id: "deliveries", label: "Deliveries", path: "/deliveries", icon: Truck },
        { id: "couriers", label: "Couriers", path: "/couriers", icon: Send, adminOnly: true },
        { id: "waybill-generator", label: "Waybill Generator", path: "/waybill-generator", icon: PackageCheck },
        { id: "delivery-partners", label: "Delivery Partners", path: "/delivery-partners", icon: Settings, adminOnly: true },
      ],
    },
    {
      id: "admin",
      label: "Admin",
      icon: SlidersHorizontal,
      path: "/attendance",
      adminOnly: true,
      subItems: [
        { id: "attendance", label: "Attendance", path: "/attendance", icon: Clock },
        { id: "audit-log", label: "Audit Log", path: "/audit-log", icon: ClipboardList },
        { id: "general-settings", label: "General Settings", path: "/settings/general", icon: Settings },
      ],
    },
  ];

  const visibleMenu = menu.filter((item) => !item.adminOnly || isAdmin);

  function itemVisible(item: MenuSubItem) {
    return !item.adminOnly || isAdmin;
  }

  useEffect(() => {
    const path = location.pathname;
    const isOnPos = path === "/pos" || path === "/sales" || path === "/promotions" || path === "/quotations";
    const isOnInventory = path === "/inventory" || path === "/products" || path === "/products/add";
    const isOnDirectory = path === "/customers" || path === "/customers/add" || path === "/staff" || path === "/suppliers";
    const isOnPurchases = path === "/purchases" || path === "/supplier-payments";
    const isOnFinance = path === "/cash-book" || path === "/cheques";
    const isOnDeliveries = path === "/deliveries" || path === "/couriers" || path === "/couriers/history" || path === "/waybill-generator" || path === "/delivery-partners";
    const isOnAdmin = path === "/attendance" || path === "/settings/general" || path === "/audit-log";

    if (isOnPos) setOpenMenuId("pos");
    else if (isOnInventory) setOpenMenuId("inventory");
    else if (isOnDirectory) setOpenMenuId("directory");
    else if (isOnPurchases) setOpenMenuId("purchases");
    else if (isOnFinance) setOpenMenuId("finance");
    else if (isOnDeliveries) setOpenMenuId("deliveries");
    else if (isOnAdmin) setOpenMenuId("admin");
  }, [location.pathname]);

  function toggleMenu(id: string) {
    setOpenMenuId((prev) => (prev === id ? null : id));
  }

  useEffect(() => {
    if (!openMenuId) return;
    // Wait a tick so the sub-items have actually rendered (and the
    // container has its real expanded height) before measuring/scrolling.
    const id = requestAnimationFrame(() => {
      menuItemRefs.current[openMenuId]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [openMenuId]);

  function handleLinkClick() {
    if (window.innerWidth < 1024) setSidebarOpen(false);
  }

  function handleLogout() {
    if (!confirm("Are you sure you want to log out?")) return;
    logout();
    navigate("/login", { replace: true });
  }

  function isParentActive(item: MenuItem): boolean {
    if (item.id === "dashboard") return location.pathname === "/";
    if (item.subItems) return item.subItems.some((sub) => location.pathname === sub.path);
    return location.pathname.startsWith(item.path);
  }

  const initials = (user?.name || user?.username || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const isOnProfile = location.pathname === "/profile";

  return (
    <div className="min-h-screen flex bg-gray-50 text-black">
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 bg-black/50 z-40 lg:hidden transition-opacity duration-300"
        />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-50 w-56 lg:w-64 bg-black text-white flex flex-col
          transform transition-transform duration-300 ease-in-out
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}
      >
        <div className="p-4 lg:p-6 border-b border-gray-800 space-y-1 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShoppingBag size={24} className="text-white" />
              <h1 className="text-xl lg:text-2xl font-bold tracking-tight flex items-baseline gap-1">
                Kash
                <span className="text-xs italic font-light text-gray-400 hidden lg:inline">by M&amp;M</span>
              </h1>
            </div>
            <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-gray-400 hover:text-white transition">
              <X size={20} />
            </button>
          </div>
          <p className="text-xs lg:text-sm text-gray-400">{isAdmin ? "Admin Console" : "Staff Console"}</p>
        </div>

        <div className="flex-1 p-3 lg:p-4 space-y-1 lg:space-y-2 overflow-y-auto">
          {visibleMenu.map((item) => {
            const Icon = item.icon;
            const active = isParentActive(item);
            const isOpen = openMenuId === item.id;
            const visibleSubItems = item.subItems?.filter(itemVisible) ?? [];

            return (
              <div key={item.id} ref={(el) => (menuItemRefs.current[item.id] = el)} className="space-y-1">
                {item.subItems ? (
                  <button
                    onClick={() => toggleMenu(item.id)}
                    className={`w-full flex items-center justify-between gap-2 lg:gap-3 px-3 lg:px-4 py-2 lg:py-3 rounded-xl transition text-sm lg:text-base
                      ${active ? "bg-white text-black font-medium" : "text-gray-300 hover:bg-gray-900"}`}
                  >
                    <div className="flex items-center gap-2 lg:gap-3">
                      <Icon size={16} />
                      <span className="text-xs lg:text-sm">{item.label}</span>
                    </div>
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                ) : (
                  <Link
                    to={item.path}
                    onClick={handleLinkClick}
                    className={`flex items-center gap-2 lg:gap-3 px-3 lg:px-4 py-2 lg:py-3 rounded-xl transition text-sm lg:text-base
                      ${active ? "bg-white text-black font-medium" : "text-gray-300 hover:bg-gray-900"}`}
                  >
                    <Icon size={16} />
                    <span className="text-xs lg:text-sm">{item.label}</span>
                  </Link>
                )}

                {item.subItems && isOpen && (
                  <div className="ml-4 lg:ml-6 space-y-1 border-l border-gray-800 pl-2 lg:pl-3">
                    {visibleSubItems.map((sub) => {
                      const SubIcon = sub.icon;
                      const subActive = location.pathname === sub.path;
                      return (
                        <Link
                          key={sub.id}
                          to={sub.path}
                          onClick={handleLinkClick}
                          className={`flex items-center gap-2 lg:gap-3 px-3 lg:px-4 py-1.5 lg:py-2 text-xs lg:text-sm rounded-lg transition
                            ${subActive ? "bg-gray-800 text-white font-medium" : "text-gray-400 hover:text-white hover:bg-gray-800/50"}`}
                        >
                          <SubIcon size={12} />
                          <span>{sub.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-gray-800 flex-shrink-0">
          <Link
            to="/profile"
            onClick={handleLinkClick}
            className={`mx-3 lg:mx-4 my-2 lg:my-3 flex items-center gap-2 lg:gap-3 px-2 lg:px-3 py-2 rounded-xl transition
              ${isOnProfile ? "bg-gray-800" : "hover:bg-gray-900"}`}
          >
            <div className="w-8 h-8 lg:w-10 lg:h-10 bg-gray-700 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-xs lg:text-sm font-medium text-white">{initials}</span>
            </div>
            <div className="flex-1 min-w-0 hidden lg:block">
              <p className="text-sm font-medium text-gray-200 truncate">{user?.name || user?.username}</p>
              <p className="text-xs text-gray-500 capitalize">{user?.role}</p>
            </div>
          </Link>
          <div className="px-3 lg:px-4 pb-3 lg:pb-4">
            <button
              onClick={handleLogout}
              className="w-full flex items-center justify-center gap-2 px-2 lg:px-3 py-1.5 lg:py-2 bg-black border border-red-500/30 text-red-400 rounded-lg hover:bg-red-600 hover:text-white hover:border-red-600 transition text-xs lg:text-sm"
            >
              <LogOut size={14} />
              <span className="font-medium">Logout</span>
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-w-0 lg:ml-64 min-h-screen bg-gray-50">
        <div className="sticky top-0 z-30 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition"
            aria-label="Open sidebar"
          >
            <Menu size={24} className="text-gray-700" />
          </button>
          <h2 className="text-sm font-medium text-gray-700">
            {visibleMenu.find(
              (item) => location.pathname === item.path || item.subItems?.some((s) => location.pathname === s.path)
            )?.label || (isOnProfile ? "My Profile" : "Dashboard")}
          </h2>
        </div>

        <div className="p-4 lg:p-6">
          <div className="bg-white border border-gray-200 rounded-2xl p-4 lg:p-6 shadow-sm">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}