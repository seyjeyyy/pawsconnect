-- Development seed. Runs after migrations on `supabase db reset`.
-- Contains reference data only: the store's product categories. It creates no
-- products, pets, orders, users or statistics. Add real catalog and pet
-- records through the shelter workspace so nothing fictional is ever stored
-- as if it were real.
insert into public.product_categories (name, slug, description) values
  ('Dog Food', 'dog-food', 'Dry and wet food for dogs'),
  ('Cat Food', 'cat-food', 'Dry and wet food for cats'),
  ('Treats', 'treats', 'Training rewards and snacks'),
  ('Toys', 'toys', 'Play and enrichment'),
  ('Collars and Leashes', 'collars-leashes', 'Collars, leashes and harnesses'),
  ('Beds', 'beds', 'Beds and bedding'),
  ('Pet Bowls', 'bowls', 'Food and water bowls'),
  ('Grooming Supplies', 'grooming', 'Brushes, shampoo and grooming tools'),
  ('Hygiene Supplies', 'hygiene', 'Litter, pads and cleaning supplies'),
  ('Carriers and Crates', 'carriers', 'Carriers, crates and travel gear'),
  ('General Pet Accessories', 'accessories', 'Everyday accessories')
on conflict (slug) do nothing;
