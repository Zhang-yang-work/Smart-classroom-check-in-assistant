BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.teaching_groups (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id varchar(36) NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  name varchar(128) NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, name),
  UNIQUE (course_id, id)
);
ALTER TABLE public.teaching_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.teaching_groups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.teaching_groups TO service_role;

ALTER TABLE public.course_roster ADD COLUMN group_id varchar(36);
INSERT INTO public.teaching_groups (course_id, name)
  SELECT DISTINCT course_id, '原课程名单' FROM public.course_roster;
UPDATE public.course_roster r SET group_id = g.id
  FROM public.teaching_groups g WHERE r.course_id = g.course_id;
ALTER TABLE public.course_roster ALTER COLUMN group_id SET NOT NULL,
  ADD CONSTRAINT course_roster_group_fk FOREIGN KEY (course_id, group_id)
    REFERENCES public.teaching_groups(course_id, id);
CREATE INDEX course_roster_group_idx ON public.course_roster(group_id);

ALTER TABLE public.attendance_tasks
  ADD COLUMN normal_end_at timestamptz,
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN group_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.attendance_participants
  ADD COLUMN group_id varchar(36),
  ADD COLUMN group_name varchar(128);

-- Keep the demo seed path usable in an isolated test database when it inserts an
-- old-style roster. The application itself requires a group for every import.
CREATE FUNCTION public.attendance_default_roster_group()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.group_id IS NULL THEN
    INSERT INTO public.teaching_groups (course_id, name) VALUES (NEW.course_id, '原课程名单')
      ON CONFLICT (course_id, name) DO NOTHING;
    SELECT id INTO NEW.group_id FROM public.teaching_groups
      WHERE course_id = NEW.course_id AND name = '原课程名单';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_default_roster_group BEFORE INSERT ON public.course_roster
  FOR EACH ROW EXECUTE FUNCTION public.attendance_default_roster_group();

CREATE FUNCTION public.attendance_publish(
  p_actor text, p_course text, p_groups text[], p_normal integer, p_late integer
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

  -- A null array is reserved for the existing Agent's course-wide tool.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name, g.id), '[]'), count(*)
    INTO groups, selected_count FROM public.teaching_groups g
    WHERE g.course_id = p_course AND (p_groups IS NULL OR g.id = ANY(p_groups));
  IF selected_count = 0 OR (p_groups IS NOT NULL AND selected_count <> cardinality(p_groups))
  THEN RETURN '{"error":"invalid_groups"}'; END IF;

  started := clock_timestamp();
  INSERT INTO public.attendance_tasks
    (course_id, created_by, mode, start_at, normal_end_at, end_at, group_snapshot)
    VALUES (p_course, p_actor, 'normal', started, started + make_interval(mins => p_normal),
      started + make_interval(mins => p_normal + p_late), groups)
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
  RETURN to_jsonb(task) || jsonb_build_object('total', participant_count);
END $$;

-- All mutations of a published task acquire its row lock before reading the clock
-- or changing a record, so ending, signing and teacher corrections are serialized.
CREATE FUNCTION public.attendance_change(
  p_actor text, p_task text, p_action text, p_student text, p_status text, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  actor public.users%ROWTYPE;
  task public.attendance_tasks%ROWTYPE;
  before_record public.attendance_records%ROWTYPE;
  result public.attendance_records%ROWTYPE;
  student text;
  at_time timestamptz;
  active_now boolean;
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

-- JSON aggregation keeps complete snapshots even above the Data API row limit.
CREATE FUNCTION public.attendance_report(p_actor text, p_task text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('task', to_jsonb(t) || jsonb_build_object('course_name', c.name),
    'participants', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'student_no', p.student_no, 'student_name', p.student_name,
        'group_id', p.group_id, 'group_name', p.group_name, 'status', r.status,
        'signed_at', r.signed_at, 'makeup_at', r.makeup_at, 'makeup_reason', r.makeup_reason
      ) ORDER BY p.student_no)
      FROM public.attendance_participants p
      LEFT JOIN public.attendance_records r ON r.task_id = p.task_id AND r.student_no = p.student_no
      WHERE p.task_id = t.id
    ), '[]'))
  FROM public.attendance_tasks t JOIN public.courses c ON c.id = t.course_id
  JOIN public.users u ON u.id = c.teacher_user_id
  WHERE t.id = p_task AND c.teacher_user_id = p_actor AND u.role = 'teacher';
$$;

REVOKE ALL ON FUNCTION public.attendance_default_roster_group(),
  public.attendance_publish(text,text,text[],integer,integer),
  public.attendance_change(text,text,text,text,text,text), public.attendance_report(text,text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_default_roster_group(),
  public.attendance_publish(text,text,text[],integer,integer),
  public.attendance_change(text,text,text,text,text,text), public.attendance_report(text,text)
TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
