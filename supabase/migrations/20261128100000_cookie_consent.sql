begin;

-- Cookie banner choices, counted per day (India time). No visitor data is stored: just two numbers a day.
-- Google Analytics can't count visitors who decline (nothing is sent to Google for them), so the admin
-- panel reads accept/decline totals from here.
create table summit_private.consent_daily (
  day date not null,
  choice text not null check (choice in ('accepted', 'declined')),
  total integer not null default 0 check (total >= 0),
  primary key (day, choice)
);
alter table summit_private.consent_daily enable row level security;

-- Called by the public site (publishable key) when a visitor clicks Accept or Decline.
create function public.summit_record_consent(p_choice text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_choice is null or p_choice not in ('accepted', 'declined') then
    raise exception 'Invalid consent choice' using errcode = '22023';
  end if;
  insert into summit_private.consent_daily (day, choice, total)
    values ((now() at time zone 'Asia/Kolkata')::date, p_choice, 1)
    on conflict (day, choice) do update set total = summit_private.consent_daily.total + 1;
end;
$$;

-- Organizer panel: accept/decline totals for the last p_days days (1 = today).
create function public.summit_admin_consent(p_days integer default 7) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  first_day date;
begin
  if not public.summit_admin_access() then
    raise exception 'Summit admin access required' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'Invalid range' using errcode = '22023';
  end if;
  first_day := (now() at time zone 'Asia/Kolkata')::date - (p_days - 1);
  return (select jsonb_build_object(
      'accepted', coalesce(sum(total) filter (where choice = 'accepted'), 0),
      'declined', coalesce(sum(total) filter (where choice = 'declined'), 0)
    ) from summit_private.consent_daily where day >= first_day);
end;
$$;

revoke all on function public.summit_record_consent(text) from public, anon, authenticated;
revoke all on function public.summit_admin_consent(integer) from public, anon, authenticated;
grant execute on function public.summit_record_consent(text) to anon, authenticated;
grant execute on function public.summit_admin_consent(integer) to authenticated;

commit;
