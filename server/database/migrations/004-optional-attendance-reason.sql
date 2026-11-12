-- Apply after 003. Keep empty adjustment reasons NULL and retain audit entries.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.attendance_change(
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

  p_reason := nullif(btrim(p_reason), '');
  IF p_status IS NULL OR p_status NOT IN ('present', 'late', 'excused', 'absent')
    OR coalesce(length(p_reason), 0) > 256
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
REVOKE ALL ON FUNCTION public.attendance_change(text,text,text,text,text,text,double precision,double precision,double precision,bigint,bigint)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_change(text,text,text,text,text,text,double precision,double precision,double precision,bigint,bigint)
TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;