import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, PawPrint, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { SessionDestination } from '../components/SessionDestination';

export function NotFoundPage() {
  return <div className="page container"><div className="card empty-state"><PawPrint size={40} /><h1>This page wandered off.</h1><p>The link may be out of date, or the page may have moved.</p><div className="hero-buttons"><Link className="btn btn-primary" to="/">Back to home<ArrowRight size={16} /></Link><Link className="btn btn-secondary" to="/shop">Browse the shop</Link></div></div></div>;
}

/** Landing point for Supabase email links (verification, magic link). The client library reads the session from the URL. */
export function AuthCallbackPage() {
  const { user, loading, configured } = useAuth();
  if (loading) return <main className="page container" role="status"><div className="card empty-state"><ShieldCheck size={36} /><h1>Confirming your account…</h1><p>One moment while we verify your link.</p></div></main>;
  if (user) return <SessionDestination/>;
  return <main className="page container"><div className="card empty-state"><ShieldCheck size={36} /><h1>We couldn’t confirm this link.</h1><p>{configured ? 'It may have expired or already been used. Sign in, or request a new link.' : 'Account services are not connected yet.'}</p><Link className="btn btn-primary" to="/auth/login">Go to sign in<ArrowRight size={16} /></Link></div></main>;
}

function Legal({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <div className="page container"><article className="legal"><span className="eyebrow">{eyebrow}</span><h1 className="page-title">{title}</h1><div className="notice">This is a working draft that describes how the platform is built to behave. It has not been reviewed by legal counsel and is not a statement of legal compliance. PawsConnect should have it reviewed before public launch.</div>{children}<p className="muted small">Questions about this page? <Link to="/contact">Contact the shelter team</Link>.</p></article></div>;
}

export function PrivacyPage() {
  return <Legal eyebrow="PRIVACY & DATA" title="How your information is handled">
    <h2>What we collect</h2>
    <p>Account details you provide (name, email, phone), saved delivery addresses, orders and payment status, adoption applications and supporting documents, stray animal reports and their locations, transport requests, donations, volunteer applications, and messages you send us.</p>
    <h2>How it is used</h2>
    <p>To fulfil orders, review adoption applications, verify and coordinate rescue reports, arrange transport, record donations, and send updates about your requests. Compatibility scores are calculated from your quiz answers and recorded pet care profiles; shelter staff make every adoption decision.</p>
    <h2>Who can see it</h2>
    <p>You can see your own records. Authorized shelter staff can see what they need to do their work. Exact report locations, reporter contact details, adoption documents, and animal medical records are restricted to authorized personnel and are not published.</p>
    <h2>Payments</h2>
    <p>Card and e-wallet details are entered on the payment provider’s checkout page. PawsConnect stores the payment status and reference, not your card details.</p>
    <h2>Location</h2>
    <p>Sharing your device location is optional. You can always enter an address or coordinates manually. Service coverage is checked on the server against the shelter’s configured service zones.</p>
    <h2>Your choices</h2>
    <p>You can update your profile and addresses from your account, and you can ask the shelter to correct or delete your personal information, subject to records the shelter must keep.</p>
  </Legal>;
}

export function TermsPage() {
  return <Legal eyebrow="TERMS & POLICIES" title="Using PawsConnect">
    <h2>Shop orders</h2>
    <p>Prices are shown in Philippine pesos. Stock, discounts, and delivery fees are verified by the server at checkout. An order is confirmed only after the payment provider sends a verified confirmation. Unpaid orders release their reserved stock when the reservation expires.</p>
    <h2>Adoption</h2>
    <p>Adoption is not the sale of an animal. Submitting an application or receiving a compatibility score does not guarantee approval. Applications are reviewed by shelter staff, and an adoption is final only after a verified physical handover. Any adoption processing fee is disclosed before payment.</p>
    <h2>Rescue reports</h2>
    <p>Reports are reviewed and verified by staff. Submitting a report does not dispatch a rescue team. Shelter rescue operates only within approved Bulacan service zones and depends on team availability.</p>
    <h2>Pet transport</h2>
    <p>Shelter-managed live-pet transport operates only within approved Bulacan service zones and requires staff confirmation and a quotation. Requests outside coverage are assessed individually; no third-party carrier is guaranteed.</p>
    <h2>Donations</h2>
    <p>Donations are recorded separately from shop sales. Monetary donations are confirmed only after verified payment. In-kind offers are reviewed by the shelter before acceptance.</p>
    <h2>Accounts</h2>
    <p>Keep your sign-in details private. Operational roles (staff, driver, rescue personnel, veterinarian, administrator) are assigned only by an authorized administrator.</p>
  </Legal>;
}
