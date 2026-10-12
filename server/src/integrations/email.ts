import { waitUntil } from '@vercel/functions';
import { env, integrations } from '../config/env.js';
import { db } from '../config/supabase.js';

// Transactional email through Resend. Email is a courtesy copy of what the
// account already shows: a failure to send never fails or delays the action
// that triggered it, and nothing is sent until RESEND_API_KEY and RESEND_FROM
// are set. Only the recipient's own record details go into a message.
export type Message = { subject: string; lines: string[]; link?: { label: string; path: string } };
const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export const readable = (status: string) => status.replaceAll('_', ' ');
export const pesos = (centavos: number | string | null | undefined) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(centavos ?? 0) / 100);

async function deliver(userId: string, message: Message) {
  const { data } = await db().auth.admin.getUserById(userId);
  if (!data.user?.email) return;
  const url = message.link ? `${env.CLIENT_URL}${message.link.path}` : null;
  const text = [...message.lines, ...(url ? ['', `${message.link!.label}: ${url}`] : []), '', 'PawsConnect · Rowena’s Paw Shelter'].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#292524">${message.lines.map(line => `<p>${escape(line)}</p>`).join('')}${url ? `<p><a href="${escape(url)}" style="color:#c2410c;font-weight:bold">${escape(message.link!.label)}</a></p>` : ''}<p style="color:#6b625c;font-size:13px">PawsConnect · Rowena’s Paw Shelter</p></div>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM, to: [data.user.email], subject: message.subject, text, html }),
  });
  if (!response.ok) console.error('Email delivery failed:', response.status);
}
const background = (work: () => Promise<void>) => { if (integrations.resend) waitUntil(work().catch(() => { console.error('Email delivery unavailable'); })); };

/** Emails a known account in the background. */
export function emailUser(userId: string, message: Message) { background(() => deliver(userId, message)); }

/**
 * Emails the owner of a record in the background. `find` reads the record with its
 * `user_id`; anonymous records (no owner) get no email.
 */
export function emailOwner<Row extends { user_id: string | null }>(find: () => PromiseLike<{ data: unknown }>, compose: (row: Row) => Message) {
  background(async () => {
    const row = (await find()).data as Row | null;
    if (row?.user_id) await deliver(row.user_id, compose(row));
  });
}
