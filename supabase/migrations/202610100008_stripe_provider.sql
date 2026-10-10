-- Payments move from PayMongo to Stripe. The settlement logic is provider
-- neutral (it works from a checkout id, a payment id and a verified amount),
-- so only the provider label on payment_transactions changes. 'paymongo'
-- stays permitted so any rows recorded before the switch remain valid.
alter table public.payment_transactions drop constraint if exists payment_transactions_provider_check;
alter table public.payment_transactions alter column provider set default 'stripe';
alter table public.payment_transactions add constraint payment_transactions_provider_check check (provider in ('stripe', 'paymongo'));
