import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RecordFields, fieldLabel, recordTitle } from '../../client/src/components/RecordView';

// Details and review dialogs once printed the database row as it is stored: full identifiers,
// column names, JSON and provider links. These rows are the shapes that were shown that way.
const text = (record: Record<string, unknown>, kind: string, staff = false) => renderToStaticMarkup(createElement(RecordFields, { record, kind, staff })).replace(/<\/dt>/g, ': ').replace(/<\/(div|li|span|strong)>/g, '\n').replace(/<[^>]+>/g, '');
const payment = { id: '441f67ab-7bda-4204-833a-8bbe32844255', user_id: 'f3f358b0-7094-4e9d-8274-d0f9e9e1fad2', resource_type: 'order', resource_id: 'aee224f8-f67d-4210-8f2a-03437b5c60fe', provider: 'stripe', provider_checkout_id: 'cs_test_a1', provider_payment_id: null, checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_a1', amount_centavos: 50000, currency: 'PHP', status: 'pending', failure_reason: null, created_at: '2026-10-12T09:57:51.484729+00:00', paid_at: null, livemode: false, references: { user_id: 'Sample Buyer', resource_id: 'Order PC-1' } };

it('shows a payment in words, without identifiers, links or column names', () => {
  const shown = text(payment, 'payments', true);
  expect(shown).toContain('Customer: Sample Buyer');
  expect(shown).toContain('Payment for: Order PC-1');
  expect(shown).toContain('Amount: ₱500.00');
  expect(shown).toContain('Status: Pending');
  expect(shown).toContain('Payment mode: Test (no real charge)');
  expect(shown).toContain('Created: Oct 12, 2026, 5:57 PM');
  expect(shown).toContain('Paid: Not paid');
  expect(shown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  expect(shown).not.toMatch(/checkout\.stripe\.com|Centavos|Resource|Livemode|Failure/);
});

it('keeps provider references and coordinates for staff only', () => {
  expect(text(payment, 'payments', true)).toContain('Provider checkout reference: cs_test_a1');
  expect(text(payment, 'payments')).not.toContain('cs_test_a1');
  expect(text({ latitude: 14.83, city: 'Malolos' }, 'reports')).toBe('City: Malolos\n');
});

it('lays out an order: the address as an address and the items as lines', () => {
  const shown = text({ id: '9cd4872b-65d3-4355-9fbf-b4a0377bac61', order_number: 'PC-5296', status: 'cancelled', total_centavos: 25900, coupon_id: null, address_snapshot: { id: 'x', recipient_name: 'Demo Customer', line1: '45 Paseo del Congreso', barangay: 'Catmon', city: 'Malolos', province: 'Bulacan', postal_code: '3000', latitude: 14.84, is_default: false }, order_items: [{ id: 'a7a26bf0', order_id: '9cd4872b', product_id: 'p', product_name: 'Cotton Rope Tug Toy', quantity: 2, unit_price_centavos: 17900, line_total_centavos: 35800 }], shipments: [] }, 'orders', true);
  expect(shown).toContain('Delivery address: Demo Customer\n45 Paseo del Congreso\nCatmon, Malolos, Bulacan, 3000');
  expect(shown).toContain('2 × Cotton Rope Tug Toy\n₱358.00 (₱179.00 each)');
  expect(shown).not.toMatch(/[{}"]|Reference|Shipments|Voucher|latitude/);
});

it('names the record and its fields for the list they belong to', () => {
  expect(recordTitle('payments')).toBe('Payment');
  expect(recordTitle('refunds')).toBe('Refund request');
  expect(recordTitle('orders', { order_number: 'PC-1' })).toBe('Order PC-1');
  expect(fieldLabel('user_id', 'rescue')).toBe('Reported by');
  expect(fieldLabel('user_id', 'payments')).toBe('Customer');
  expect(fieldLabel('is_published')).toBe('Published');
  expect(fieldLabel('amount_centavos')).toBe('Amount');
});
