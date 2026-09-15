import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import AppShell from "./components/AppShell";

import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import InventoryPage from "./pages/InventoryPage";
import AddProductPage from "./pages/AddProductPage";
import ManageProductsPage from "./pages/ManageProductsPage";
import AddCustomerPage from "./pages/AddCustomerPage";
import ViewCustomersPage from "./pages/ViewCustomersPage";
import PosPage from "./pages/PosPage";
import SaleHistoryPage from "./pages/SaleHistoryPage";
import ReturnsPage from "./pages/ReturnsPage";
import SuppliersPage from "./pages/SuppliersPage";
import PurchasesPage from "./pages/PurchasesPage";
import PurchaseReturnsPage from "./pages/PurchaseReturnsPage";
import DeliveriesPage from "./pages/DeliveriesPage";
import CashBookPage from "./pages/CashBookPage";
import ProfilePage from "./pages/ProfilePage";
import AttendancePage from "./pages/AttendancePage";
import StaffPage from "./pages/StaffPage";
import SupplierPaymentsPage from "./pages/SupplierPaymentsPage";
import ChequesPage from "./pages/ChequesPage";
import CouriersPage from "./pages/CourierReconciliationPage";
import GeneralSettingsPage from "./pages/GeneralSettingsPage";

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
        <Route path="/inventory" element={<InventoryPage />} />

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

        <Route path="/customers/add" element={<AddCustomerPage />} />
        <Route path="/customers" element={<ViewCustomersPage />} />
        <Route
          path="/staff"
          element={
            <ProtectedRoute adminOnly>
              <StaffPage />
            </ProtectedRoute>
          }
        />

        <Route path="/sales" element={<SaleHistoryPage />} />
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
          path="/purchases"
          element={
            <ProtectedRoute adminOnly>
              <PurchasesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/purchases/returns"
          element={
            <ProtectedRoute adminOnly>
              <PurchaseReturnsPage />
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
        <Route
          path="/couriers"
          element={
            <ProtectedRoute adminOnly>
              <CouriersPage />
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
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
