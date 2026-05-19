-- Set service_mode from category so radar "Send Order" vs resolution CTAs match business type.

-- Delivery mode vendors
update public.vendors
set service_mode = 'delivery'
where category in ('Pharmacy', 'Kirana Store', 'Medicine Delivery', 'Beautician');

-- Help mode vendors
update public.vendors
set service_mode = 'help'
where category in (
  'Mechanic',
  'Towing',
  'Tyre Service',
  'Key Maker',
  'Ambulance',
  'Nursing',
  'Plumber',
  'Electrician',
  'Security'
);
