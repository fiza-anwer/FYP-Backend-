import { useEffect } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router";
import SignIn from "./pages/AuthPages/SignIn";
import SignUp from "./pages/AuthPages/SignUp";
import NotFound from "./pages/OtherPage/NotFound";
import AppLayout from "./layout/AppLayout";
import { ScrollToTop } from "./components/common/ScrollToTop";
import ProtectedRoute from "./components/auth/ProtectedRoute";
import Home from "./pages/Dashboard/Home";
import Orders from "./pages/Orders";
import Companies from "./pages/Companies";
import CompanyIntegrations from "./pages/CompanyIntegrations";
import CarrierIntegrations from "./pages/CarrierIntegrations";
import CarrierIntegrationServices from "./pages/CarrierIntegrationServices";
import Consignments from "./pages/Consignments";
import Products from "./pages/Products";
import SuperadminTenants from "./pages/Superadmin/Tenants";
import { setOnUnauthorized } from "./api/client";
import { useAuth } from "./context/AuthContext";

function AppRoutes() {
  const { logout } = useAuth();
  useEffect(() => {
    setOnUnauthorized(() => {
      logout();
      window.location.href = "/signin";
    });
    return () => setOnUnauthorized(null);
  }, [logout]);

  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/signup" element={<SignUp />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index path="/" element={<Home />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/consignments" element={<Consignments />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/company-integrations" element={<CompanyIntegrations />} />
          <Route path="/carrier-integrations" element={<CarrierIntegrations />} />
          <Route path="/carrier-integration-services" element={<CarrierIntegrationServices />} />
          <Route path="/products" element={<Products />} />
          <Route path="/superadmin/tenants" element={<SuperadminTenants />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <Router>
      <ScrollToTop />
      <AppRoutes />
    </Router>
  );
}
