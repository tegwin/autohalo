-- ============================================================================
-- Bootstrap the first platform administrator.
--
-- Run this ONCE, after signing up through the app with the address below.
-- Platform admins bypass billing entirely (unlimited trials and live runs) and
-- can see every organisation, so promote deliberately — there is no
-- self-service route to this role.
--
-- Plain SQL, safe to paste straight into the Supabase SQL Editor. Change the
-- three email literals below if you use a different address.
-- ============================================================================

update public.profiles
   set is_platform_admin = true
 where email = 'chris@sondelaconsulting.com';

-- Give the admin's own org unlimited runs too, so day-to-day migrations are
-- not gated by entitlements or trial limits either.
update public.orgs
   set unlimited = true
 where id in (
   select m.org_id
     from public.memberships m
     join public.profiles p on p.id = m.user_id
    where p.email = 'chris@sondelaconsulting.com'
 );

-- Verify. Expect one row with is_platform_admin = true and unlimited = true.
-- If this returns nothing, sign up in the app with that email first, then re-run.
select p.email, p.is_platform_admin, o.name as org, o.unlimited
  from public.profiles p
  join public.memberships m on m.user_id = p.id
  join public.orgs o on o.id = m.org_id
 where p.email = 'chris@sondelaconsulting.com';
