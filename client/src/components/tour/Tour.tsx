import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Compass, Heart, HeartHandshake, LayoutDashboard, MapPin, PawPrint, ShieldCheck, ShoppingBag, Sparkles, Truck, UserRound, X, type LucideIcon } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { isOperational } from '../../lib/roles';
import './tour.css';

type Step = {
  /** Page the step lives on. The tour navigates there before looking for the target. */
  route: string;
  /** CSS selectors tried in order; the first visible match is spotlighted. Omit for a centered card. */
  targets?: string[];
  icon: LucideIcon;
  title: string;
  body: string;
  staffOnly?: boolean;
  customerOnly?: boolean;
};

const steps: Step[] = [
  { route: '/', icon: PawPrint, title: 'Welcome to PawsConnect', body: 'One place to adopt, shop, rescue, donate and arrange pet transport with Rowena’s Paw Shelter in Bulacan. This short tour shows you where everything is. It takes about a minute.' },
  { route: '/', targets: ['.desktop-nav', '.mobile-toggle'], icon: Compass, title: 'Everything starts here', body: 'The menu takes you to each service. They work independently: you can shop without adopting, or report a stray without buying anything.' },
  { route: '/adopt', targets: ['.pet-filters', '.page-intro'], icon: Heart, title: 'Meet adoptable companions', body: 'Search and filter the shelter’s animals by species, size and sex. Open a profile to read about a pet and apply. Every application is reviewed by shelter staff; applying never reserves or adopts a pet on its own.' },
  { route: '/match', targets: ['.quiz-options', '.quiz-card'], icon: Sparkles, title: 'Find your paw-fect match', body: 'Answer four short steps about your lifestyle and home. Each pet gets a compatibility score calculated from its recorded care profile, with the reasons shown. It is guidance only: people make the adoption decision.' },
  { route: '/shop', targets: ['.catalog-toolbar', '.page-intro'], icon: ShoppingBag, title: 'Shop pet essentials', body: 'Browse food, toys, beds and more by category, search by name and sort by price. Prices are in Philippine pesos and stock is shown on every item.' },
  { route: '/shop', targets: ['.cart-icon'], icon: ShieldCheck, title: 'Your bag and secure checkout', body: 'Items you add wait here. At checkout the server confirms prices, stock and the delivery fee for your address, then you pay on Stripe’s secure page. An order is marked paid only after Stripe confirms it.' },
  { route: '/rescue', targets: ['.location-map', '.location-picker'], icon: MapPin, title: 'Report a stray on the map', body: 'Describe the animal, then click the map or search an address to drop a pin. You can check whether the spot is inside the shelter’s rescue coverage. Staff verify every report before any team is sent.' },
  { route: '/transport', targets: ['.tabs', '.service-form'], icon: Truck, title: 'Safe journeys for pets', body: 'Request shelter-managed transport within approved Bulacan zones and receive a quotation from staff. Outside coverage, switch to an alternative request and the shelter will assess the arrangement.' },
  { route: '/donate', targets: ['.donation-amounts', '.service-form'], icon: HeartHandshake, title: 'Support the shelter', body: 'Give a one-time amount or offer supplies in kind. Donations are recorded separately from shop sales, and a monetary gift is confirmed only after the payment is verified.' },
  { route: '/account', targets: ['.account-sidebar', '.account-gate'], icon: UserRound, customerOnly: true, title: 'Your account, all in one place', body: 'Track orders, payments, adoption applications, rescue reports, transport requests and donations here, and keep your delivery addresses and profile up to date.' },
  { route: '/admin', targets: ['.account-sidebar'], icon: LayoutDashboard, staffOnly: true, title: 'The shelter workspace', body: 'Shelter personnel work here, and each role sees only its own tools: staff manage the store, adoptions, rescue and transport; veterinarians keep health records; rescue personnel and drivers see the jobs assigned to them.' },
  { route: '/', icon: PawPrint, title: 'You’re all set', body: 'That’s the whole platform. You can replay this tour any time from “Take the tour” at the top of the page or in the footer.' },
];

const SEEN_KEY = 'pawsconnect-tour-seen-v1';
const seen = () => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage unavailable: the invitation simply shows again */ } };

type Box = { top: number; left: number; width: number; height: number };
const TourContext = createContext<{ active: boolean; start: () => void } | null>(null);
export function useTour() {
  const context = useContext(TourContext);
  if (!context) throw new Error('TourProvider is missing');
  return context;
}

const visible = (element: Element) => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const findTarget = (step: Step) => { for (const selector of step.targets ?? []) { const match = [...document.querySelectorAll(selector)].find(visible); if (match) return match; } return null; };
const onRoute = (pathname: string, route: string) => route === '/' ? pathname === '/' : pathname === route || pathname.startsWith(route + '/');

export function TourProvider({ children }: { children: ReactNode }) {
  const { roles } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const operational = isOperational(roles);
  const sequence = useMemo(() => steps.filter(step => operational ? !step.customerOnly : !step.staffOnly), [operational]);

  const [index, setIndex] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [searching, setSearching] = useState(false);
  const [gliding, setGliding] = useState(false);
  const [cardSize, setCardSize] = useState({ width: 380, height: 250 });
  const card = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const active = index !== null;
  const step = active ? sequence[Math.min(index, sequence.length - 1)] : null;

  const start = useCallback(() => { returnFocus.current = document.activeElement as HTMLElement | null; setBox(null); setIndex(0); }, []);
  const close = useCallback(() => { markSeen(); setIndex(null); setBox(null); returnFocus.current?.focus?.({ preventScroll: true }); }, []);
  const go = useCallback((delta: number) => setIndex(current => {
    if (current === null) return current;
    const next = current + delta;
    if (next >= sequence.length) { markSeen(); returnFocus.current?.focus?.({ preventScroll: true }); return null; }
    return Math.max(0, next);
  }), [sequence.length]);

  // Go to the step's page, then follow its target every frame so the spotlight
  // stays attached through scrolling, resizing and late-loading content.
  useEffect(() => {
    if (!step) return;
    if (!onRoute(pathname, step.route)) { navigate(step.route); return; }
    if (!step.targets) { setBox(null); setSearching(false); return; }
    setSearching(true);
    setGliding(true);
    let frame = 0, scrolled = false, last = '';
    const startedAt = performance.now();
    const settle = window.setTimeout(() => setGliding(false), 900);
    const track = () => {
      const target = findTarget(step);
      if (target) {
        if (!scrolled) {
          scrolled = true;
          const r = target.getBoundingClientRect();
          // Park the target just under the sticky header, which leaves the most room for the card below it.
          const top = r.top + window.scrollY - 130;
          const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          window.scrollTo({ top: Math.max(0, top), behavior: calm ? 'auto' : 'smooth' });
        }
        const r = target.getBoundingClientRect();
        const next = { top: r.top, left: r.left, width: r.width, height: r.height };
        const key = `${Math.round(next.top)}:${Math.round(next.left)}:${Math.round(next.width)}:${Math.round(next.height)}`;
        if (key !== last) { last = key; setBox(next); setSearching(false); }
      } else if (performance.now() - startedAt > 3000 && last !== 'none') {
        // Target never appeared (for example a section hidden at this screen size): fall back to a centered card.
        last = 'none'; setBox(null); setSearching(false);
      }
      frame = requestAnimationFrame(track);
    };
    frame = requestAnimationFrame(track);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); };
  }, [step, pathname, navigate]);

  useLayoutEffect(() => {
    if (!card.current) return;
    const { width, height } = card.current.getBoundingClientRect();
    setCardSize(size => Math.abs(size.width - width) > 1 || Math.abs(size.height - height) > 1 ? { width, height } : size);
  });

  // Keyboard: arrows to move, Escape to leave, Tab stays inside the card.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
      else if (event.key === 'Tab' && card.current) {
        const focusable = [...card.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
        if (!focusable.length) return;
        const first = focusable[0], lastButton = focusable[focusable.length - 1];
        if (!card.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); lastButton.focus(); }
        else if (!event.shiftKey && document.activeElement === lastButton) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, close, go]);

  useEffect(() => { if (active) card.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus({ preventScroll: true }); }, [index, active]);

  const value = useMemo(() => ({ active, start }), [active, start]);
  let overlay: ReactNode = null;
  if (step && index !== null) {
    const pad = 8, gap = 16, margin = 16;
    const vw = window.innerWidth, vh = window.innerHeight;
    const spot = box && { top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
    // Place the card under the target, else above it, else pinned to the bottom of the screen.
    let top = (vh - cardSize.height) / 2, left = (vw - cardSize.width) / 2;
    if (spot) {
      const below = spot.top + spot.height + gap, above = spot.top - gap - cardSize.height;
      top = below + cardSize.height <= vh - margin ? below : above >= margin ? above : vh - cardSize.height - margin;
      left = spot.left + spot.width / 2 - cardSize.width / 2;
    }
    left = Math.min(Math.max(margin, left), Math.max(margin, vw - cardSize.width - margin));
    top = Math.min(Math.max(margin, top), Math.max(margin, vh - cardSize.height - margin));
    const Icon = step.icon;
    const isLast = index === sequence.length - 1;
    overlay = <div className={`tour${gliding ? ' tour-gliding' : ''}`}>
      {/* Blocks clicks on the page while the tour is open, and dims it when nothing is spotlighted. */}
      <div className={`tour-backdrop${spot ? '' : ' tour-backdrop-dim'}`} aria-hidden="true" />
      {spot && <div className="tour-spotlight" aria-hidden="true" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} />}
      <div ref={card} className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" style={{ top, left, opacity: searching && !box ? 0 : 1 }}>
        <div className="tour-progress" role="progressbar" aria-label="Tour progress" aria-valuemin={1} aria-valuemax={sequence.length} aria-valuenow={index + 1}><span style={{ width: `${((index + 1) / sequence.length) * 100}%` }} /></div>
        <div className="tour-content" key={index}>
          <div className="tour-head"><span className="tour-icon"><Icon size={20} /></span><span className="tour-count">Step {index + 1} of {sequence.length}</span><button className="tour-close" onClick={close} aria-label="Close the tour"><X size={18} /></button></div>
          <h2 id="tour-title">{step.title}</h2>
          <p id="tour-body">{step.body}</p>
        </div>
        <div className="tour-actions">
          {index > 0 ? <button className="btn btn-secondary" onClick={() => go(-1)}><ArrowLeft size={16} />Back</button> : <button className="text-button" onClick={close}>Skip the tour</button>}
          <button className="btn btn-primary" data-tour-primary onClick={() => go(1)}>{isLast ? 'Finish' : index === 0 ? 'Start the tour' : 'Next'}{!isLast && <ArrowRight size={16} />}</button>
        </div>
      </div>
    </div>;
  }
  return <TourContext.Provider value={value}>{children}{overlay}</TourContext.Provider>;
}

/** Button that starts the tour. Used in the top bar and the footer. */
export function TourButton({ className = 'tour-link', children = 'Take the tour' }: { className?: string; children?: ReactNode }) {
  const { start } = useTour();
  return <button type="button" className={className} onClick={start}><Compass size={14} />{children}</button>;
}

/** One-time, dismissible invitation shown to first-time visitors on the home page. */
export function TourInvitation() {
  const { active, start } = useTour();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (pathname !== '/' || seen()) { setOpen(false); return; }
    const timer = window.setTimeout(() => setOpen(true), 1400);
    return () => window.clearTimeout(timer);
  }, [pathname]);
  if (!open || active) return null;
  const dismiss = () => { markSeen(); setOpen(false); };
  return <aside className="tour-invite" aria-label="Site tour invitation">
    <span className="tour-icon"><Compass size={20} /></span>
    <div><strong>New here?</strong><p>Take a one-minute tour of what you can do.</p><div className="tour-invite-actions"><button className="btn btn-primary" onClick={() => { setOpen(false); start(); }}>Show me around</button><button className="text-button" onClick={dismiss}>No thanks</button></div></div>
    <button className="tour-close" onClick={dismiss} aria-label="Dismiss the tour invitation"><X size={16} /></button>
  </aside>;
}
