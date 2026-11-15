-- T102. Immutable confirmation binding, single-use decisions, forced tenant isolation.
DO $$ BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Confirmation migration requires dap_owner'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.sec_confirmations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 256),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
  action_id text NOT NULL CHECK (action_id ~ '^[a-z][A-Za-z0-9]{2,63}$'),
  definition_version integer NOT NULL CHECK (definition_version > 0),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  params jsonb NOT NULL,
  params_digest text NOT NULL CHECK (params_digest ~ '^[a-f0-9]{64}$'),
  resource_type text, resource_id text,
  risk text NOT NULL CHECK (risk IN ('SAFE','LOW','MEDIUM','HIGH','CRITICAL')),
  consequence jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','invalidated','expired')),
  execution_status text NOT NULL DEFAULT 'none' CHECK (execution_status IN ('none','succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  CHECK ((resource_type IS NULL) = (resource_id IS NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '900 seconds'),
  CHECK ((status = 'pending' AND decided_at IS NULL) OR (status <> 'pending' AND decided_at IS NOT NULL)),
  CHECK (execution_status = 'none' OR status = 'accepted')
);
DO $$ BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.sec_confirmations'::regclass) <> 'dap_owner' THEN
    RAISE EXCEPTION 'Confirmation table must belong to dap_owner';
  END IF;
END $$;
ALTER TABLE public.sec_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_confirmations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_select ON public.sec_confirmations;
DROP POLICY IF EXISTS tenant_insert ON public.sec_confirmations;
DROP POLICY IF EXISTS tenant_update ON public.sec_confirmations;
CREATE POLICY tenant_select ON public.sec_confirmations FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_insert ON public.sec_confirmations FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_update ON public.sec_confirmations FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.sec_confirmations FROM PUBLIC, dap_app;
GRANT SELECT, INSERT ON public.sec_confirmations TO dap_app;
-- Only the state machine needs updates. Bindings have no application UPDATE privilege at all.
GRANT UPDATE (status,execution_status,decided_at) ON public.sec_confirmations TO dap_app;

CREATE OR REPLACE FUNCTION public.sec_confirmations_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.execution_status <> 'none' OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'Confirmation must start pending' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.user_id,NEW.request_id,NEW.action_id,NEW.definition_version,NEW.definition_hash,NEW.params,NEW.params_digest,NEW.resource_type,NEW.resource_id,NEW.risk,NEW.consequence,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.user_id,OLD.request_id,OLD.action_id,OLD.definition_version,OLD.definition_hash,OLD.params,OLD.params_digest,OLD.resource_type,OLD.resource_id,OLD.risk,OLD.consequence,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'Confirmation binding is immutable' USING ERRCODE='42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('accepted','rejected','invalidated','expired') OR NEW.decided_at IS NULL OR NEW.execution_status <> 'none' THEN
      RAISE EXCEPTION 'Confirmation decision is final' USING ERRCODE='42501';
    END IF;
    IF NEW.status IN ('accepted','rejected') AND OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'Confirmation has expired' USING ERRCODE='42501';
    END IF;
    IF NEW.status = 'expired' AND OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'Confirmation is still live' USING ERRCODE='42501';
    END IF;
  ELSE
    IF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'Confirmation decision time is immutable' USING ERRCODE='42501';
    END IF;
    IF NEW.execution_status IS DISTINCT FROM OLD.execution_status AND
      (OLD.status <> 'accepted' OR OLD.execution_status <> 'none' OR NEW.execution_status NOT IN ('succeeded','failed')) THEN
      RAISE EXCEPTION 'Confirmation execution is one-shot' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sec_confirmations_guard() FROM PUBLIC, dap_app;
DROP TRIGGER IF EXISTS sec_confirmations_guard ON public.sec_confirmations;
CREATE TRIGGER sec_confirmations_guard BEFORE INSERT OR UPDATE ON public.sec_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.sec_confirmations_guard();
CREATE INDEX IF NOT EXISTS sec_confirmations_pending ON public.sec_confirmations (tenant_id,user_id,status,expires_at);
