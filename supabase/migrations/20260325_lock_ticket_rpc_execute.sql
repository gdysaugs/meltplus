-- Lock ticket RPC execution to service_role only.
-- This prevents anon/authenticated clients from calling credit mutation RPCs directly.

revoke execute on function public.consume_tickets(uuid, text, integer, text, jsonb) from public;
revoke execute on function public.consume_tickets(uuid, text, integer, text, jsonb) from anon;
revoke execute on function public.consume_tickets(uuid, text, integer, text, jsonb) from authenticated;
grant execute on function public.consume_tickets(uuid, text, integer, text, jsonb) to service_role;

revoke execute on function public.refund_tickets(uuid, text, integer, text, jsonb) from public;
revoke execute on function public.refund_tickets(uuid, text, integer, text, jsonb) from anon;
revoke execute on function public.refund_tickets(uuid, text, integer, text, jsonb) from authenticated;
grant execute on function public.refund_tickets(uuid, text, integer, text, jsonb) to service_role;

revoke execute on function public.grant_tickets(text, uuid, text, integer, text, jsonb, text) from public;
revoke execute on function public.grant_tickets(text, uuid, text, integer, text, jsonb, text) from anon;
revoke execute on function public.grant_tickets(text, uuid, text, integer, text, jsonb, text) from authenticated;
grant execute on function public.grant_tickets(text, uuid, text, integer, text, jsonb, text) to service_role;
