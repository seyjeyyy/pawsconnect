import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/layout/Layout';
import WorkspaceLayout from './components/layout/WorkspaceLayout';
import { SessionDestination } from './components/SessionDestination';
import { useAuth } from './contexts/AuthContext';
import { TourProvider, useTour } from './components/tour/Tour';
import AssistantLauncher from './components/assistant/AssistantLauncher';
import Home from './pages/Home';
import { AuthCallbackPage, NotFoundPage, PrivacyPage, TermsPage } from './pages/Info';

// Load maps, checkout forms, charts and workspace tools only on their routes.
const adoption = () => import('./pages/Adoption');
const AdoptPage = lazy(() => adoption().then(m => ({ default: m.AdoptPage })));
const PetPage = lazy(() => adoption().then(m => ({ default: m.PetPage })));
const shop = () => import('./pages/Shop');
const ShopPage = lazy(() => shop().then(m => ({ default: m.ShopPage })));
const ProductPage = lazy(() => shop().then(m => ({ default: m.ProductPage })));
const CartPage = lazy(() => shop().then(m => ({ default: m.CartPage })));
const CheckoutPage = lazy(() => shop().then(m => ({ default: m.CheckoutPage })));
const PaymentReturnPage = lazy(() => shop().then(m => ({ default: m.PaymentReturnPage })));
const account = () => import('./pages/Account');
const AuthPage = lazy(() => import('./pages/Auth').then(m => ({ default: m.AuthPage })));
const DashboardPage = lazy(() => account().then(m => ({ default: m.DashboardPage })));
const AdminPage = lazy(() => account().then(m => ({ default: m.AdminPage })));
const OperationsPage = lazy(() => import('./pages/Operations'));
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
        <Route element={<LandingPage/>}><Route index element={<Home/>}/></Route>
        <Route element={<Layout />}>
          <Route path="welcome" element={<Home />} />
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
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        <Route element={<WorkspaceLayout/>}>
          <Route path="account" element={<DashboardPage />} />
          <Route path="account/:tab" element={<DashboardPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="admin/operations" element={<OperationsPage />} />
          <Route path="admin/operations/:section" element={<OperationsPage />} />
          <Route path="admin/:section" element={<AdminPage />} />
          {/* Paths used in notification links written by the database. */}
          <Route path="orders/:id" element={<Navigate to="/account/orders" replace />} />
          <Route path="dashboard" element={<Navigate to="/account" replace />} />
        </Route>
      </Routes>
    </Suspense>
    <AssistantLauncher />
    </TourProvider>
  );
}

function LandingPage() {
  const {user, loading, rolesError} = useAuth();
  const {active} = useTour();
  if (loading) return <Loading/>;
  return !active && (user || rolesError) ? <SessionDestination/> : <Layout/>;
}
