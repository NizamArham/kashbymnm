import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import AppShell from "./components/AppShell";

import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import InventoryCategoriesPage from "./pages/InventoryCategoriesPage";
import AddProductPage from "./pages/AddProductPage";
import ManageProductsPage from "./pages/ManageProductsPage";
import AddCustomerPage from "./pages/AddCustomerPage";
import CustomerOrderHistoryPage from "./pages/CustomerOrderHistoryPage";
import CustomerPaymentHistoryPage from "./pages/CustomerPaymentHistoryPage";
import CustomerLoyaltyHistoryPage from "./pages/CustomerLoyaltyHistoryPage";
import WaybillGeneratorPage from "./pages/WaybillGeneratorPage";
import SupplierPaymentHistoryPage from "./pages/SupplierPaymentHistoryPage";
import ViewCustomersPage from "./pages/ViewCustomersPage";
import PosPage from "./pages/PosPage";
import SaleHistoryPage from "./pages/SaleHistoryPage";
import SaleDetailPage from "./pages/SaleDetailPage";
import ProductDetailPage from "./pages/ProductDetailPage";
import ReturnsPage from "./pages/ReturnsPage";
import SuppliersPage from "./pages/SuppliersPage";
import PurchasesPage from "./pages/PurchasesPage";
import DeliveriesPage from "./pages/DeliveriesPage";
import CashBookPage from "./pages/CashBookPage";
import ProfilePage from "./pages/ProfilePage";
import AttendancePage from "./pages/AttendancePage";
import StaffPage from "./pages/StaffPage";
import AddStaffPage from "./pages/AddStaffPage";
import SupplierPaymentsPage from "./pages/SupplierPaymentsPage";
import ChequesPage from "./pages/ChequesPage";
import CouriersPage from "./pages/CourierReconciliationPage";
import CourierOrderHistoryPage from "./pages/CourierOrderHistoryPage";
import GeneralSettingsPage from "./pages/GeneralSettingsPage";
import FindPage from "./pages/FindPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import AuditLogPage from "./pages/AuditLogPage";
import PromotionsPage from "./pages/PromotionsPage";

// Root path behaves differently per role: admin sees the Dashboard,
// staff is redirected straight to POS, matching the access model.
function RoleAwareHome() {
  const { user } = useAuth();
  if (user?.role === "staff") return <Navigate to="/pos" replace />;
  return <DashboardPage />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<RoleAwareHome />} />
        <Route path="/pos" element={<PosPage />} />
        <Route path="/inventory" element={<InventoryCategoriesPage />} />
        <Route path="/inventory/categories" element={<Navigate to="/inventory" replace />} />

        <Route
          path="/products/add"
          element={
            <ProtectedRoute adminOnly>
              <AddProductPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/products"
          element={
            <ProtectedRoute adminOnly>
              <ManageProductsPage />
            </ProtectedRoute>
          }
        />
        <Route path="/products/:id" element={<ProductDetailPage />} />

        <Route path="/customers/add" element={<AddCustomerPage />} />
        <Route path="/customers/:id/orders" element={<CustomerOrderHistoryPage />} />
        <Route path="/customers/:id/payment-history" element={<CustomerPaymentHistoryPage />} />
        <Route path="/customers/:id/loyalty-history" element={<CustomerLoyaltyHistoryPage />} />
        <Route path="/customers" element={<ViewCustomersPage />} />
        <Route
          path="/staff"
          element={
            <ProtectedRoute adminOnly>
              <StaffPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/staff/add"
          element={
            <ProtectedRoute adminOnly>
              <AddStaffPage />
            </ProtectedRoute>
          }
        />

        <Route path="/sales" element={<SaleHistoryPage />} />
        <Route path="/sales/:id" element={<SaleDetailPage />} />
        <Route path="/returns" element={<ReturnsPage />} />

        <Route
          path="/suppliers"
          element={
            <ProtectedRoute adminOnly>
              <SuppliersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/suppliers/:id/payment-history"
          element={
            <ProtectedRoute adminOnly>
              <SupplierPaymentHistoryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/purchases"
          element={
            <ProtectedRoute adminOnly>
              <PurchasesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/supplier-payments"
          element={
            <ProtectedRoute adminOnly>
              <SupplierPaymentsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/cheques"
          element={
            <ProtectedRoute adminOnly>
              <ChequesPage />
            </ProtectedRoute>
          }
        />
        <Route path="/deliveries" element={<DeliveriesPage />} />
        <Route path="/waybill-generator" element={<WaybillGeneratorPage />} />
        <Route
          path="/couriers"
          element={
            <ProtectedRoute adminOnly>
              <CouriersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/couriers/history"
          element={
            <ProtectedRoute adminOnly>
              <CourierOrderHistoryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/cash-book"
          element={
            <ProtectedRoute adminOnly>
              <CashBookPage />
            </ProtectedRoute>
          }
        />

        <Route path="/profile" element={<ProfilePage />} />
        <Route
          path="/attendance"
          element={
            <ProtectedRoute adminOnly>
              <AttendancePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings/general"
          element={
            <ProtectedRoute adminOnly>
              <GeneralSettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/find"
          element={
            <ProtectedRoute adminOnly>
              <FindPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/analytics"
          element={
            <ProtectedRoute adminOnly>
              <AnalyticsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/audit-log"
          element={
            <ProtectedRoute adminOnly>
              <AuditLogPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/promotions"
          element={
            <ProtectedRoute adminOnly>
              <PromotionsPage />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
