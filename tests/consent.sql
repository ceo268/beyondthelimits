-- Cookie consent counters. Run after all migrations; everything is rolled back.
begin;

insert into auth.users(id, email) values
  ('c0a5e000-0000-4000-8000-000000000001', 'organizer@example.test'),
  ('c0a5e000-0000-4000-8000-000000000002', 'other@example.test');
insert into summit_private.admin_users(user_id) values ('c0a5e000-0000-4000-8000-000000000001');

do $$
begin
  if not has_function_privilege('anon', 'public.summit_record_consent(text)', 'execute') then
    raise exception 'Visitors cannot record a consent choice';
  end if;
  if has_function_privilege('anon', 'public.summit_admin_consent(integer)', 'execute') then
    raise exception 'Consent totals are readable without signing in';
  end if;
  if has_schema_privilege('anon', 'summit_private', 'usage') then
    raise exception 'Private schema is exposed';
  end if;
end;
$$;

set local role anon;
select public.summit_record_consent('accepted');
select public.summit_record_consent('accepted');
select public.summit_record_consent('declined');
do $$
begin
  begin
    perform public.summit_record_consent('maybe');
    raise exception 'An invalid choice was recorded';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
reset role;

-- An older day falls outside the "today" range but inside 7 days.
insert into summit_private.consent_daily (day, choice, total)
  values ((now() at time zone 'Asia/Kolkata')::date - 3, 'declined', 5);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c0a5e000-0000-4000-8000-000000000002', true);
do $$
begin
  perform public.summit_admin_consent(7);
  raise exception 'A non-organizer read consent totals';
exception when insufficient_privilege then null;
end;
$$;
select set_config('request.jwt.claim.sub', 'c0a5e000-0000-4000-8000-000000000001', true);
do $$
declare
  today jsonb := public.summit_admin_consent(1);
  week jsonb := public.summit_admin_consent(7);
begin
  if today <> '{"accepted": 2, "declined": 1}'::jsonb then raise exception 'Today totals wrong: %', today; end if;
  if week <> '{"accepted": 2, "declined": 6}'::jsonb then raise exception 'Week totals wrong: %', week; end if;
  begin
    perform public.summit_admin_consent(0);
    raise exception 'Invalid range accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
reset role;

rollback;
