import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/layout/Layout';
import { TourProvider } from './components/tour/Tour';
import Home from './pages/Home';
import { AdoptPage, PetPage } from './pages/Adoption';
import { AuthCallbackPage, NotFoundPage, PrivacyPage, TermsPage } from './pages/Info';
import { CartPage, CheckoutPage, PaymentReturnPage, ProductPage, ShopPage } from './pages/Shop';

// The account module (charting library) and the service forms (form and
// validation libraries) load on demand to keep the storefront bundle small.
const account = () => import('./pages/Account');
const AuthPage = lazy(() => account().then(m => ({ default: m.AuthPage })));
const DashboardPage = lazy(() => account().then(m => ({ default: m.DashboardPage })));
const AdminPage = lazy(() => account().then(m => ({ default: m.AdminPage })));
const services = () => import('./pages/Services');
const MatchPage = lazy(() => services().then(m => ({ default: m.MatchPage })));
const RescuePage = lazy(() => services().then(m => ({ default: m.RescuePage })));
const TransportPage = lazy(() => services().then(m => ({ default: m.TransportPage })));
const DonatePage = lazy(() => services().then(m => ({ default: m.DonatePage })));
const VolunteerPage = lazy(() => services().then(m => ({ default: m.VolunteerPage })));
const AboutPage = lazy(() => services().then(m => ({ default: m.AboutPage })));
const ContactPage = lazy(() => services().then(m => ({ default: m.ContactPage })));

const Loading = () => <div className="page container" role="status" aria-label="Loading"><div className="dashboard-skeleton"><div /><div /><div /></div></div>;

export default function App() {
  return (
    <TourProvider>
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/auth" element={<Navigate to="/auth/login" replace />} />
        <Route path="/auth/:mode" element={<AuthPage />} />
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="adopt" element={<AdoptPage />} />
          <Route path="adopt/:id" element={<PetPage />} />
          <Route path="match" element={<MatchPage />} />
          <Route path="shop" element={<ShopPage />} />
          <Route path="shop/:id" element={<ProductPage />} />
          <Route path="cart" element={<CartPage />} />
          <Route path="checkout" element={<CheckoutPage />} />
          <Route path="payment/return" element={<PaymentReturnPage />} />
          <Route path="rescue" element={<RescuePage />} />
          <Route path="transport" element={<TransportPage />} />
          <Route path="donate" element={<DonatePage />} />
          <Route path="volunteer" element={<VolunteerPage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="contact" element={<ContactPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="terms" element={<TermsPage />} />
          <Route path="account" element={<DashboardPage />} />
          <Route path="account/:tab" element={<DashboardPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="admin/:section" element={<AdminPage />} />
          {/* Paths used in notification links written by the database. */}
          <Route path="orders/:id" element={<Navigate to="/account/orders" replace />} />
          <Route path="dashboard" element={<Navigate to="/account" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
    </TourProvider>
  );
}
