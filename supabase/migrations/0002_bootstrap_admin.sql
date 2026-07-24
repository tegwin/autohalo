-- ============================================================================
-- Bootstrap the first platform administrator.
--
-- Run this ONCE, after signing up through the app with the address below.
-- Platform admins bypass billing entirely and can see every organisation, so
-- promote deliberately — there is no self-service route to this role.
-- ============================================================================

-- Replace with the email you signed up with.
\set admin_email 'chris@sondelaconsulting.co.uk'

update public.profiles
   set is_platform_admin = true
 where email = :'admin_email';

-- Give the admin's own org unlimited runs too, so their day-to-day migrations
-- are not gated by entitlements either.
update public.orgs
   set unlimited = true
 where id in (
   select m.org_id
     from public.memberships m
     join public.profiles p on p.id = m.user_id
    where p.email = :'admin_email'
 );

-- Verify.
select p.email, p.is_platform_admin, o.name as org, o.unlimited
  from public.profiles p
  join public.memberships m on m.user_id = p.id
  join public.orgs o on o.id = m.org_id
 where p.email = :'admin_email';
