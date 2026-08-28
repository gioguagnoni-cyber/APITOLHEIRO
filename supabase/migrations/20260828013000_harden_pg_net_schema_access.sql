-- pg_net is registered by the managed platform as a non-relocatable extension.
-- Its operational objects live in schema net; no browser role needs access to it.

revoke all on schema net from public, anon, authenticated;
revoke all on all tables in schema net from public, anon, authenticated;
revoke all on all sequences in schema net from public, anon, authenticated;
revoke all on all functions in schema net from public, anon, authenticated;
