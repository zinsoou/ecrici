-- Admin can permanently delete a SUSPENDED shop (used by the Delete button in admin.html)
create or replace function public.admin_delete_shop(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if exists (select 1 from public.admins where user_id = target) then raise exception 'cannot delete an admin'; end if;
  if not exists (select 1 from public.shops where id = target and status = 'suspended') then raise exception 'suspend the shop first'; end if;
  delete from auth.users where id = target;
end $$;
revoke all on function public.admin_delete_shop(uuid) from public, anon;
grant execute on function public.admin_delete_shop(uuid) to authenticated;
