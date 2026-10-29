-- Run once in Supabase > SQL Editor (adds the "Reset password" button's database function)
create or replace function public.admin_set_password(target uuid, new_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if length(coalesce(new_password, '')) < 6 then raise exception 'password too short'; end if;
  update auth.users
     set encrypted_password = crypt(new_password, gen_salt('bf', 10)), updated_at = now()
   where id = target;
end $$;
revoke all on function public.admin_set_password(uuid, text) from public, anon;
grant execute on function public.admin_set_password(uuid, text) to authenticated;
