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
} from "lucide-react";
import { useState, useEffect } from "react";
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

  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>({
    pos: false,
    inventory: false,
    directory: false,
    purchases: false,
    finance: false,
    deliveries: false,
    admin: false,
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const menu: MenuItem[] = [
    { id: "dashboard", label: "Dashboard", icon: Home, path: "/" },
    {
      id: "pos",
      label: "POS",
      icon: ShoppingCart,
      path: "/pos",
      subItems: [
        { id: "checkout", label: "Checkout", path: "/pos", icon: ShoppingCart },
        { id: "sales-history", label: "Sale History", path: "/sales", icon: History },
      ],
    },
    {
      id: "inventory",
      label: "Inventory",
      icon: Package,
      path: "/inventory",
      subItems: [
        { id: "view-inventory", label: "View Inventory", path: "/inventory", icon: Search },
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
        { id: "purchase-returns", label: "Purchase Returns", path: "/purchases/returns", icon: RotateCcw },
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
    const isOnPos = path === "/pos" || path === "/sales";
    const isOnInventory = path === "/inventory" || path === "/products" || path === "/products/add";
    const isOnDirectory = path === "/customers" || path === "/customers/add" || path === "/staff" || path === "/suppliers";
    const isOnPurchases = path === "/purchases" || path === "/purchases/returns" || path === "/supplier-payments";
    const isOnFinance = path === "/cash-book" || path === "/cheques";
    const isOnDeliveries = path === "/deliveries" || path === "/couriers" || path === "/waybill-generator";
    const isOnAdmin = path === "/attendance" || path === "/settings/general";

    if (isOnPos) setOpenMenus((prev) => ({ ...prev, pos: true }));
    if (isOnInventory) setOpenMenus((prev) => ({ ...prev, inventory: true }));
    if (isOnDirectory) setOpenMenus((prev) => ({ ...prev, directory: true }));
    if (isOnPurchases) setOpenMenus((prev) => ({ ...prev, purchases: true }));
    if (isOnFinance) setOpenMenus((prev) => ({ ...prev, finance: true }));
    if (isOnDeliveries) setOpenMenus((prev) => ({ ...prev, deliveries: true }));
    if (isOnAdmin) setOpenMenus((prev) => ({ ...prev, admin: true }));
  }, [location.pathname]);

  function toggleMenu(id: string) {
    setOpenMenus((prev) => ({ ...prev, [id]: !prev[id] }));
  }

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
            const isOpen = openMenus[item.id];
            const visibleSubItems = item.subItems?.filter(itemVisible) ?? [];

            return (
              <div key={item.id} className="space-y-1">
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

      <div className="flex-1 lg:ml-64 min-h-screen bg-gray-50">
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