import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Copy, Gift, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import { api, money } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import './vouchers.css';

export type Voucher = {
  code: string; name: string; description: string | null; kind: 'promo' | 'first_purchase' | 'loyalty'; applies_to: 'subtotal' | 'delivery';
  discount_percent: number | null; discount_centavos: number | null; max_discount_centavos: number | null; minimum_subtotal_centavos: number;
  expires_at: string; status: 'available' | 'held' | 'used' | 'expired' | 'unavailable'; remaining_uses: number; used_count: number; last_order_number: string | null;
};
type Loyalty = { name: string; metric: 'orders' | 'spend'; threshold: number; progress: number; earned: number; reward_name: string };
export type Wallet = { vouchers: Voucher[]; loyalty: Loyalty[] };

// The voucher a customer chose in their wallet, carried to checkout. It is only a prefill:
// checkout asks the server whether it applies.
const CHOSEN_KEY = 'pawsconnect_voucher';
export const chosenVoucher = {
  get: () => { try { return sessionStorage.getItem(CHOSEN_KEY) || ''; } catch { return ''; } },
  set: (code: string) => { try { if (code) sessionStorage.setItem(CHOSEN_KEY, code); else sessionStorage.removeItem(CHOSEN_KEY); } catch { /* storage unavailable: the customer can type the code */ } },
};

export const useWallet = () => {
  const { user } = useAuth();
  return useQuery({ queryKey: ['vouchers', user?.id], queryFn: ({ signal }) => api<Wallet>('/vouchers/mine', { signal }), enabled: !!user });
};

const day = (value: string) => new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: 'Asia/Manila' }).format(new Date(Date.parse(value) - 1));
export const voucherAmount = (voucher: Pick<Voucher, 'applies_to' | 'discount_percent' | 'discount_centavos'>) =>
  voucher.applies_to === 'delivery' && voucher.discount_percent === 100 ? 'Free delivery'
    : `${voucher.discount_percent != null ? `${voucher.discount_percent}%` : money(Number(voucher.discount_centavos))} off${voucher.applies_to === 'delivery' ? ' delivery' : ''}`;
/** The conditions of a voucher, in the order a customer checks them. */
export function voucherTerms(voucher: Voucher) {
  return [
    voucher.minimum_subtotal_centavos > 0 && `Minimum spend ${money(voucher.minimum_subtotal_centavos)}`,
    voucher.max_discount_centavos != null && voucher.discount_percent != null && `Up to ${money(voucher.max_discount_centavos)} off`,
    voucher.kind === 'first_purchase' && 'First order only',
    voucher.kind === 'loyalty' && 'Loyalty reward',
    voucher.remaining_uses > 1 && `${voucher.remaining_uses} uses left`,
  ].filter(Boolean) as string[];
}

const tabs = [['available', 'Available'], ['used', 'Used'], ['expired', 'Expired']] as const;
const inTab = (voucher: Voucher, tab: string) => tab === 'available' ? voucher.status === 'available' : tab === 'used' ? ['used', 'held'].includes(voucher.status) : ['expired', 'unavailable'].includes(voucher.status);

export function MyVouchers() {
  const wallet = useWallet(), cart = useCart(), navigate = useNavigate();
  const [tab, setTab] = useState<string>('available');
  if (wallet.isLoading) return <div className="dashboard-skeleton" role="status" aria-label="Loading vouchers"><div /><div /></div>;
  if (wallet.error) return <div className="notice error" role="alert">{(wallet.error as Error).message} <button className="text-button" onClick={() => wallet.refetch()}>Try again</button></div>;
  const { vouchers = [], loyalty = [] } = wallet.data ?? {};
  const shown = vouchers.filter(voucher => inTab(voucher, tab));
  const use = (code: string) => { chosenVoucher.set(code); if (cart.count > 0) navigate('/checkout'); else { toast.info('Add items to your bag. The voucher is applied at checkout.'); navigate('/shop'); } };
  return <>
    {loyalty.length > 0 && <div className="loyalty-grid">{loyalty.map(rule => {
      const left = rule.threshold - rule.progress;
      return <section className="card loyalty-card" key={rule.name}>
        <span className="loyalty-icon"><Gift size={22} /></span>
        <div>
          <h3>{rule.name}</h3>
          <p>{rule.metric === 'orders' ? `${left} more paid ${left === 1 ? 'order' : 'orders'}` : `${money(left)} more in paid orders`} to earn <strong>{rule.reward_name}</strong>.</p>
          <div className="loyalty-bar" role="progressbar" aria-valuemin={0} aria-valuemax={rule.threshold} aria-valuenow={rule.progress} aria-label={`${rule.name} progress`}><span style={{ width: `${Math.round(rule.progress / rule.threshold * 100)}%` }} /></div>
          <small>{rule.metric === 'orders' ? `${rule.progress} of ${rule.threshold} orders` : `${money(rule.progress)} of ${money(rule.threshold)}`}{rule.earned > 0 && ` · ${rule.earned} earned so far`}</small>
        </div>
      </section>;
    })}</div>}
    <div className="segmented" role="tablist" aria-label="Voucher status">{tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}<span>{vouchers.filter(voucher => inTab(voucher, key)).length}</span></button>)}</div>
    {!shown.length ? <div className="card empty-state"><Ticket size={34} /><h3>{tab === 'available' ? 'No vouchers to use right now' : tab === 'used' ? 'You have not used a voucher yet' : 'No expired vouchers'}</h3>{tab === 'available' && <p>New promotions and the rewards you earn appear here.</p>}</div>
      : <div className="voucher-grid">{shown.map(voucher => <article className={`voucher-card voucher-${voucher.status}`} key={voucher.code}>
        <div className="voucher-value"><Ticket size={20} /><strong>{voucherAmount(voucher)}</strong></div>
        <div className="voucher-body">
          <h3>{voucher.name}</h3>
          {voucher.description && <p>{voucher.description}</p>}
          <ul>{voucherTerms(voucher).map(term => <li key={term}>{term}</li>)}<li>{voucher.status === 'expired' ? 'Expired' : 'Valid until'} {day(voucher.expires_at)}</li></ul>
          <div className="voucher-foot">
            <button className="voucher-code" title="Copy code" onClick={async () => { try { await navigator.clipboard.writeText(voucher.code); toast.success('Code copied'); } catch { toast.info(`Code: ${voucher.code}`); } }}><Copy size={14} />{voucher.code}</button>
            {voucher.status === 'available' ? <button className="btn btn-primary" onClick={() => use(voucher.code)}>Use voucher<ArrowRight size={16} /></button>
              : voucher.status === 'held' ? <span className="badge">On an order awaiting payment</span>
              : voucher.status === 'used' ? <span className="badge badge-green"><Check size={13} />Used{voucher.last_order_number ? ` on ${voucher.last_order_number}` : ''}</span>
              : <span className="badge">{voucher.status === 'expired' ? 'Expired' : 'No longer available'}</span>}
          </div>
        </div>
      </article>)}</div>}
  </>;
}
