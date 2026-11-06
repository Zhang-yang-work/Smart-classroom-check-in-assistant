BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.attendance_tasks
  ADD COLUMN location_latitude double precision,
  ADD COLUMN location_longitude double precision,
  ADD COLUMN location_radius_m integer,
  ADD COLUMN location_name varchar(128),
  ADD CONSTRAINT attendance_tasks_location_check CHECK (
    (mode = 'location' AND location_latitude IS NOT NULL AND location_latitude BETWEEN -90 AND 90
      AND location_longitude IS NOT NULL AND location_longitude BETWEEN -180 AND 180
      AND location_radius_m IS NOT NULL AND location_radius_m IN (50,100,200)
      AND location_name IS NOT NULL AND btrim(location_name) <> '')
    OR (mode <> 'location' AND location_latitude IS NULL AND location_longitude IS NULL
      AND location_radius_m IS NULL AND location_name IS NULL)
  );

-- Remove the old signatures so no endpoint can bypass mode validation.
DROP FUNCTION public.attendance_publish(text,text,text[],integer,integer);
DROP FUNCTION public.attendance_change(text,text,text,text,text,text);

CREATE FUNCTION public.attendance_publish(
  p_actor text, p_course text, p_groups text[], p_normal integer, p_late integer,
  p_mode text DEFAULT 'normal', p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL,
  p_radius integer DEFAULT NULL, p_location_name text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  task public.attendance_tasks%ROWTYPE;
  groups jsonb;
  selected_count integer;
  participant_count integer;
  started timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.courses c JOIN public.users u ON u.id = c.teacher_user_id
    WHERE c.id = p_course AND u.id = p_actor AND u.role = 'teacher')
  THEN RETURN '{"error":"not_found"}'; END IF;
  IF p_normal IS NULL OR p_normal NOT BETWEEN 1 AND 1440 OR p_late IS NULL OR p_late NOT BETWEEN 0 AND 1440
  THEN RETURN '{"error":"invalid"}'; END IF;

  IF p_mode IS NULL OR p_mode NOT IN ('normal', 'location', 'qr')
  THEN RETURN '{"error":"invalid"}'; END IF;
  IF p_mode = 'location' AND (
    p_lat IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng IS NULL OR p_lng NOT BETWEEN -180 AND 180
    OR p_radius IS NULL OR p_radius NOT IN (50,100,200)
    OR p_location_name IS NULL OR length(btrim(p_location_name)) NOT BETWEEN 1 AND 128
  ) THEN RETURN '{"error":"invalid_location"}'; END IF;
  IF p_mode <> 'location' AND (p_lat IS NOT NULL OR p_lng IS NOT NULL OR p_radius IS NOT NULL OR p_location_name IS NOT NULL)
  THEN RETURN '{"error":"invalid"}'; END IF;

  -- A null array is reserved for the existing Agent's course-wide tool.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name, g.id), '[]'), count(*)
    INTO groups, selected_count FROM public.teaching_groups g
    WHERE g.course_id = p_course AND (p_groups IS NULL OR g.id = ANY(p_groups));
  IF selected_count = 0 OR (p_groups IS NOT NULL AND selected_count <> cardinality(p_groups))
  THEN RETURN '{"error":"invalid_groups"}'; END IF;

  started := clock_timestamp();
  INSERT INTO public.attendance_tasks
    (course_id, created_by, mode, start_at, normal_end_at, end_at, group_snapshot,
      location_latitude, location_longitude, location_radius_m, location_name)
    VALUES (p_course, p_actor, p_mode, started, started + make_interval(mins => p_normal),
      started + make_interval(mins => p_normal + p_late), groups, p_lat, p_lng, p_radius, p_location_name)
    RETURNING * INTO task;
  INSERT INTO public.attendance_participants
    (task_id, student_no, student_name, course_roster_id, group_id, group_name)
    SELECT DISTINCT ON (r.student_no) task.id, r.student_no, r.student_name, r.id, r.group_id, g.name
      FROM public.course_roster r
      JOIN jsonb_to_recordset(groups) AS g(id text, name text) ON g.id = r.group_id
      WHERE r.course_id = p_course ORDER BY r.student_no, r.group_id, r.id;
  GET DIAGNOSTICS participant_count = ROW_COUNT;
  IF participant_count = 0 THEN
    DELETE FROM public.attendance_tasks WHERE id = task.id;
    RETURN '{"error":"empty_roster"}';
  END IF;
  INSERT INTO public.operation_logs (operator_user_id, action, task_id, details)
    VALUES (p_actor, 'create_task', task.id, jsonb_build_object('total', participant_count,
      'normal_minutes', p_normal, 'late_minutes', p_late));
  RETURN (to_jsonb(task) - 'location_latitude' - 'location_longitude') || jsonb_build_object('total', participant_count);
END $$;

-- Keep the existing task lock and shared attendance transaction for all modes.
CREATE FUNCTION public.attendance_change(
  p_actor text, p_task text, p_action text, p_student text, p_status text, p_reason text,
  p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL,
  p_accuracy double precision DEFAULT NULL, p_captured_ms bigint DEFAULT NULL,
  p_qr_expires_ms bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  actor public.users%ROWTYPE;
  task public.attendance_tasks%ROWTYPE;
  before_record public.attendance_records%ROWTYPE;
  result public.attendance_records%ROWTYPE;
  student text;
  at_time timestamptz;
  active_now boolean;
  now_ms bigint;
  distance_m double precision;
  previous_status text;
BEGIN
  SELECT * INTO actor FROM public.users WHERE id = p_actor;
  IF NOT FOUND THEN RETURN '{"error":"not_found"}'; END IF;
  IF p_action = 'sign' AND actor.role = 'student' THEN
    student := actor.student_no;
  ELSIF p_action IN ('end', 'adjust') AND actor.role = 'teacher' THEN
    student := p_student;
  ELSE RETURN '{"error":"not_found"}';
  END IF;

  SELECT t.* INTO task FROM public.attendance_tasks t
    JOIN public.courses c ON c.id = t.course_id WHERE t.id = p_task AND (
      (actor.role = 'teacher' AND c.teacher_user_id = p_actor)
      OR (actor.role = 'student' AND EXISTS (
        SELECT 1 FROM public.attendance_participants p WHERE p.task_id = t.id AND p.student_no = student
      ))
    ) FOR UPDATE OF t;
  IF NOT FOUND THEN RETURN '{"error":"not_found"}'; END IF;

  at_time := clock_timestamp();
  active_now := task.status = 'active' AND task.ended_at IS NULL AND at_time < task.end_at;
  IF p_action = 'end' THEN
    IF active_now THEN
      UPDATE public.attendance_tasks SET status = 'ended', ended_at = at_time WHERE id = p_task;
      INSERT INTO public.operation_logs (operator_user_id, action, task_id)
        VALUES (p_actor, 'end_attendance', p_task);
    END IF;
    RETURN '{"status":"ended"}';
  END IF;

  IF p_action = 'sign' THEN
    IF NOT active_now OR at_time < task.start_at THEN RETURN '{"error":"closed"}'; END IF;
    now_ms := floor(extract(epoch FROM at_time) * 1000);
    IF task.mode = 'location' THEN
      IF p_lat IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng IS NULL OR p_lng NOT BETWEEN -180 AND 180
        OR p_accuracy IS NULL OR p_accuracy <= 0 OR p_accuracy > least(task.location_radius_m, 100)
      THEN RETURN '{"error":"invalid_location"}'; END IF;
      IF p_captured_ms IS NULL OR p_captured_ms NOT BETWEEN now_ms - 60000 AND now_ms + 15000
      THEN RETURN '{"error":"stale_location"}'; END IF;
      distance_m := 2 * 6371008.8 * asin(least(1.0, sqrt(
        power(sin(radians((p_lat - task.location_latitude) / 2)), 2)
        + cos(radians(task.location_latitude)) * cos(radians(p_lat))
        * power(sin(radians((p_lng - task.location_longitude) / 2)), 2)
      )));
      IF distance_m > task.location_radius_m THEN RETURN '{"error":"out_of_range"}'; END IF;
    ELSIF task.mode = 'qr' THEN
      -- Nest verifies the signature and binds the claim to p_task. Only service_role can
      -- call this RPC. Check expiry again under the task lock to cover queued requests.
      IF p_qr_expires_ms IS NULL OR p_qr_expires_ms <= now_ms OR p_qr_expires_ms > now_ms + 12000
      THEN RETURN '{"error":"expired_qr"}'; END IF;
    ELSIF task.mode NOT IN ('normal', 'quick') THEN
      RETURN '{"error":"invalid"}';
    END IF;
    INSERT INTO public.attendance_records (task_id, student_no, status, signed_at)
      VALUES (p_task, student, CASE WHEN at_time < coalesce(task.normal_end_at, task.end_at)
        THEN 'present' ELSE 'late' END, at_time)
      ON CONFLICT (task_id, student_no) DO NOTHING RETURNING * INTO result;
    IF NOT FOUND THEN RETURN '{"error":"duplicate"}'; END IF;
    INSERT INTO public.operation_logs (operator_user_id, action, task_id, student_no)
      VALUES (p_actor, 'sign_in', p_task, student);
    RETURN jsonb_build_object('id', result.id, 'status', result.status, 'signed_at', result.signed_at);
  END IF;

  IF p_status IS NULL OR p_status NOT IN ('present', 'late', 'excused', 'absent')
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 256
  THEN RETURN '{"error":"invalid"}'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.attendance_participants p WHERE p.task_id = p_task AND p.student_no = student)
  THEN RETURN '{"error":"not_participant"}'; END IF;
  SELECT * INTO before_record FROM public.attendance_records r WHERE r.task_id = p_task AND r.student_no = student;
  previous_status := coalesce(before_record.status, CASE WHEN active_now THEN 'unsigned' ELSE 'absent' END);
  INSERT INTO public.attendance_records (task_id, student_no, status, makeup_at, makeup_by, makeup_reason, updated_at)
    VALUES (p_task, student, p_status, at_time, p_actor, p_reason, at_time)
    ON CONFLICT (task_id, student_no) DO UPDATE SET status = EXCLUDED.status,
      makeup_at = EXCLUDED.makeup_at, makeup_by = EXCLUDED.makeup_by,
      makeup_reason = EXCLUDED.makeup_reason, updated_at = EXCLUDED.updated_at
    RETURNING * INTO result;
  INSERT INTO public.operation_logs (operator_user_id, action, task_id, student_no, details)
    VALUES (p_actor, 'adjust_attendance', p_task, student, jsonb_build_object(
      'before', previous_status, 'after', p_status, 'reason', p_reason,
      'previous_adjustment', before_record.makeup_reason, 'previous_adjusted_by', before_record.makeup_by,
      'previous_adjusted_at', before_record.makeup_at));
  RETURN jsonb_build_object('id', result.id, 'status', result.status, 'makeup_at', result.makeup_at);
END $$;

REVOKE ALL ON FUNCTION public.attendance_publish(text,text,text[],integer,integer,text,double precision,double precision,integer,text),
  public.attendance_change(text,text,text,text,text,text,double precision,double precision,double precision,bigint,bigint)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_publish(text,text,text[],integer,integer,text,double precision,double precision,integer,text),
  public.attendance_change(text,text,text,text,text,text,double precision,double precision,double precision,bigint,bigint)
TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
