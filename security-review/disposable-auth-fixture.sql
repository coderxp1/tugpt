-- DISPOSABLE DATABASE ONLY: image ships a pre-GoTrue legacy auth skeleton.
-- Identity helpers below match the supplied production export; columns are test fixtures.
ALTER TABLE auth.users ADD COLUMN email_confirmed_at timestamptz, ADD COLUMN deleted_at timestamptz;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid;
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
 select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role'))::text;
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
 select coalesce(nullif(current_setting('request.jwt.claim',true),''),nullif(current_setting('request.jwt.claims',true),''))::jsonb;
$$;
ALTER TABLE auth.users ADD COLUMN email_change_token_new varchar;
