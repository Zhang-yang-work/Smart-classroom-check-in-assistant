-- Apply once, with ON_ERROR_STOP, after backing up and draining legacy app instances.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Preserve exact text keys used in historical attendance. Resolve anomalies separately.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.users WHERE role = 'student'
      AND (student_no IS NULL OR btrim(student_no) = '' OR student_no <> btrim(student_no))
  ) OR EXISTS (
    SELECT 1 FROM public.course_roster
    WHERE btrim(student_no) = '' OR student_no <> btrim(student_no)
  ) THEN
    RAISE EXCEPTION 'Noncanonical student numbers require review before migration';
  END IF;
END $$;

ALTER TABLE public.users
  ADD COLUMN wx_app_id varchar(64),
  ADD COLUMN wx_open_id varchar(128),
  ADD COLUMN employee_no varchar(64),
  ADD COLUMN activation_hash varchar(64),
  ADD COLUMN activation_expires_at timestamptz,
  ADD CONSTRAINT users_wx_identity_pair CHECK (
    (wx_app_id IS NULL AND wx_open_id IS NULL)
    OR (wx_app_id IS NOT NULL AND wx_open_id IS NOT NULL AND wx_app_id <> '' AND wx_open_id <> '')
  ),
  ADD CONSTRAINT users_teacher_activation_fields CHECK (
    ((activation_hash IS NULL AND activation_expires_at IS NULL)
     OR (activation_hash IS NOT NULL AND activation_expires_at IS NOT NULL
         AND employee_no IS NOT NULL AND wx_open_id IS NULL AND activation_hash ~ '^[0-9a-f]{64}$'))
    AND (employee_no IS NULL OR (role = 'teacher' AND employee_no = btrim(employee_no) AND employee_no <> ''))
  );
CREATE UNIQUE INDEX users_wx_identity_uidx ON public.users (wx_app_id, wx_open_id);
CREATE UNIQUE INDEX users_employee_no_uidx ON public.users (employee_no);
CREATE UNIQUE INDEX users_activation_hash_uidx ON public.users (activation_hash);
CREATE UNIQUE INDEX users_student_identity_uidx ON public.users (student_no) WHERE role = 'student';
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.users FROM PUBLIC, anon, authenticated;

-- Serialize imports with first binding for the same student number.
CREATE FUNCTION public.auth_link_roster_student()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('student', NEW.student_no)::text, 0));
  IF NEW.linked_user_id IS NULL THEN
    SELECT id INTO NEW.linked_user_id FROM public.users
      WHERE role = 'student' AND student_no = NEW.student_no AND name = NEW.student_name;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.auth_link_roster_student() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_link_roster_student() TO service_role;
CREATE TRIGGER auth_link_roster_student BEFORE INSERT ON public.course_roster
  FOR EACH ROW EXECUTE FUNCTION public.auth_link_roster_student();

CREATE TABLE public.auth_sessions (
  token_hash varchar(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id varchar(36) REFERENCES public.users(id) ON DELETE RESTRICT,
  wx_app_id varchar(64) NOT NULL,
  wx_open_id varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  attempt_window_at timestamptz NOT NULL DEFAULT now()
);
-- A row without user_id is an onboarding ticket, never an access session.
CREATE UNIQUE INDEX auth_sessions_onboarding_uidx
  ON public.auth_sessions (wx_app_id, wx_open_id) WHERE user_id IS NULL;
CREATE INDEX auth_sessions_user_id_idx ON public.auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_at_idx ON public.auth_sessions (expires_at);
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_sessions TO service_role;

CREATE FUNCTION public.auth_wechat_session(p_app text, p_open text, p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  account public.users%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('wx', p_app, p_open)::text, 0));
  SELECT * INTO account FROM public.users
    WHERE wx_app_id = p_app AND wx_open_id = p_open FOR UPDATE;
  IF FOUND THEN
    INSERT INTO public.auth_sessions (token_hash, user_id, wx_app_id, wx_open_id, expires_at)
    VALUES (p_hash, account.id, p_app, p_open, clock_timestamp() + interval '7 days');
    RETURN jsonb_build_object('user', jsonb_build_object(
      'id', account.id, 'name', account.name, 'role', account.role, 'student_no', account.student_no));
  END IF;

  INSERT INTO public.auth_sessions (token_hash, wx_app_id, wx_open_id, expires_at)
  VALUES (p_hash, p_app, p_open, clock_timestamp() + interval '5 minutes')
  ON CONFLICT (wx_app_id, wx_open_id) WHERE user_id IS NULL
    DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, revoked_at = NULL;
  RETURN jsonb_build_object('user', NULL);
END $$;

CREATE FUNCTION public.auth_bind_wechat(
  p_ticket text, p_hash text, p_role text, p_number text, p_name text, p_activation text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  ticket public.auth_sessions%ROWTYPE;
  account public.users%ROWTYPE;
BEGIN
  SELECT * INTO ticket FROM public.auth_sessions WHERE token_hash = p_ticket AND user_id IS NULL;
  IF NOT FOUND THEN RETURN '{"error":"expired"}'; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(jsonb_build_array('wx', ticket.wx_app_id, ticket.wx_open_id)::text, 0));
  SELECT * INTO ticket FROM public.auth_sessions
    WHERE token_hash = p_ticket AND user_id IS NULL AND revoked_at IS NULL
      AND expires_at > clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN '{"error":"expired"}'; END IF;

  IF ticket.attempt_window_at <= clock_timestamp() - interval '10 minutes' THEN
    UPDATE public.auth_sessions SET attempts = 0, attempt_window_at = clock_timestamp()
      WHERE token_hash = p_ticket RETURNING * INTO ticket;
  END IF;
  IF ticket.attempts >= 5 THEN RETURN '{"error":"limited"}'; END IF;
  UPDATE public.auth_sessions SET attempts = attempts + 1 WHERE token_hash = p_ticket;

  IF EXISTS (SELECT 1 FROM public.users WHERE wx_app_id = ticket.wx_app_id AND wx_open_id = ticket.wx_open_id)
  THEN RETURN '{"error":"conflict"}'; END IF;

  IF p_role = 'student' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('student', p_number)::text, 0));
    SELECT * INTO account FROM public.users WHERE role = 'student' AND student_no = p_number FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM public.course_roster WHERE student_no = p_number AND student_name = p_name
    ) OR EXISTS (
      SELECT 1 FROM public.course_roster WHERE student_no = p_number AND
        (student_name <> p_name OR (linked_user_id IS NOT NULL AND linked_user_id IS DISTINCT FROM account.id))
    ) OR (account.id IS NOT NULL AND account.name <> p_name)
    THEN RETURN '{"error":"mismatch"}'; END IF;

    IF account.wx_open_id IS NOT NULL THEN RETURN '{"error":"conflict"}'; END IF;
    IF account.id IS NULL THEN
      INSERT INTO public.users (role, name, student_no)
        VALUES ('student', p_name, p_number) RETURNING * INTO account;
    END IF;
    UPDATE public.course_roster SET linked_user_id = account.id
      WHERE student_no = p_number AND student_name = p_name AND linked_user_id IS NULL;
  ELSIF p_role = 'teacher' THEN
    SELECT * INTO account FROM public.users
      WHERE role = 'teacher' AND employee_no = p_number AND name = p_name
        AND wx_open_id IS NULL AND activation_hash = p_activation
        AND activation_expires_at > clock_timestamp() FOR UPDATE;
    IF NOT FOUND THEN RETURN '{"error":"mismatch"}'; END IF;
  ELSE
    RETURN '{"error":"mismatch"}';
  END IF;

  UPDATE public.users SET wx_app_id = ticket.wx_app_id, wx_open_id = ticket.wx_open_id,
    activation_hash = NULL, activation_expires_at = NULL WHERE id = account.id;
  UPDATE public.auth_sessions SET revoked_at = clock_timestamp() WHERE token_hash = p_ticket;
  INSERT INTO public.auth_sessions (token_hash, user_id, wx_app_id, wx_open_id, expires_at)
    VALUES (p_hash, account.id, ticket.wx_app_id, ticket.wx_open_id, clock_timestamp() + interval '7 days');
  INSERT INTO public.operation_logs (operator_user_id, action)
    VALUES (account.id, CASE WHEN p_role = 'teacher' THEN 'wechat_activate_teacher' ELSE 'wechat_bind_student' END);
  RETURN jsonb_build_object('user', jsonb_build_object(
    'id', account.id, 'name', account.name, 'role', account.role, 'student_no', account.student_no));
END $$;

CREATE FUNCTION public.auth_resolve_session(p_hash text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', u.id, 'name', u.name, 'role', u.role, 'student_no', u.student_no)
  FROM public.auth_sessions s JOIN public.users u ON u.id = s.user_id
    AND u.wx_app_id = s.wx_app_id AND u.wx_open_id = s.wx_open_id
  WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > statement_timestamp()
    AND u.role IN ('student', 'teacher');
$$;

CREATE FUNCTION public.auth_logout(p_hash text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  account_id text;
BEGIN
  UPDATE public.auth_sessions SET revoked_at = clock_timestamp()
    WHERE token_hash = p_hash AND revoked_at IS NULL AND expires_at > clock_timestamp()
    RETURNING user_id INTO account_id;
  IF account_id IS NOT NULL THEN
    INSERT INTO public.operation_logs (operator_user_id, action) VALUES (account_id, 'wechat_logout');
  END IF;
END $$;

-- Operator-only revocation. Retains bindings, user IDs and business history.
CREATE FUNCTION public.auth_revoke_user_sessions(p_user_id text)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  affected integer;
BEGIN
  PERFORM 1 FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  UPDATE public.auth_sessions SET revoked_at = clock_timestamp()
    WHERE user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    INSERT INTO public.operation_logs (operator_user_id, action, details)
      VALUES (p_user_id, 'wechat_sessions_revoked', '{"actor":"database_operator"}');
  END IF;
  RETURN affected;
END $$;

REVOKE ALL ON FUNCTION public.auth_wechat_session(text,text,text),
  public.auth_bind_wechat(text,text,text,text,text,text), public.auth_resolve_session(text),
  public.auth_logout(text), public.auth_revoke_user_sessions(text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_wechat_session(text,text,text),
  public.auth_bind_wechat(text,text,text,text,text,text), public.auth_resolve_session(text),
  public.auth_logout(text)
TO service_role;
REVOKE EXECUTE ON FUNCTION public.auth_revoke_user_sessions(text) FROM service_role;

-- Prevent old credentials from surviving an accidental rollback to the legacy guard.
UPDATE public.users SET token = NULL, teacher_code = NULL
  WHERE token IS NOT NULL OR teacher_code IS NOT NULL;
NOTIFY pgrst, 'reload schema';
COMMIT;
