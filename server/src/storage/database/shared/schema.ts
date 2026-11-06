import { pgTable, serial, varchar, timestamp, jsonb, index, uniqueIndex, integer, check, foreignKey, unique } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// ================== 系统表（勿删勿改） ==================
export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// ================== 用户（教师 / 学生） ==================
export const users = pgTable(
	"users",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		role: varchar("role", { length: 20 }).notNull(), // 'student' | 'teacher'
		name: varchar("name", { length: 64 }).notNull(),
		student_no: varchar("student_no", { length: 64 }), // 学生学号，教师为 null
		teacher_code: varchar("teacher_code", { length: 64 }), // Legacy column, unused after cutover
		token: varchar("token", { length: 64 }), // Legacy column, unused after cutover
		wx_app_id: varchar("wx_app_id", { length: 64 }),
		wx_open_id: varchar("wx_open_id", { length: 128 }),
		employee_no: varchar("employee_no", { length: 64 }),
		activation_hash: varchar("activation_hash", { length: 64 }),
		activation_expires_at: timestamp("activation_expires_at", { withTimezone: true }),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("users_token_idx").on(table.token),
		index("users_role_idx").on(table.role),
		index("users_student_no_idx").on(table.student_no),
		uniqueIndex("users_student_identity_uidx").on(table.student_no).where(sql`${table.role} = 'student'`),
		uniqueIndex("users_wx_identity_uidx").on(table.wx_app_id, table.wx_open_id),
		uniqueIndex("users_employee_no_uidx").on(table.employee_no),
		uniqueIndex("users_activation_hash_uidx").on(table.activation_hash),
		check("users_wx_identity_pair", sql`
			(${table.wx_app_id} IS NULL AND ${table.wx_open_id} IS NULL)
			OR (${table.wx_app_id} IS NOT NULL AND ${table.wx_open_id} IS NOT NULL
				AND ${table.wx_app_id} <> '' AND ${table.wx_open_id} <> '')`),
		check("users_teacher_activation_fields", sql`
			((${table.activation_hash} IS NULL AND ${table.activation_expires_at} IS NULL)
			OR (${table.activation_hash} IS NOT NULL AND ${table.activation_expires_at} IS NOT NULL
				AND ${table.employee_no} IS NOT NULL AND ${table.wx_open_id} IS NULL
				AND ${table.activation_hash} ~ '^[0-9a-f]{64}$'))
			AND (${table.employee_no} IS NULL OR (${table.role} = 'teacher'
				AND ${table.employee_no} = btrim(${table.employee_no}) AND ${table.employee_no} <> ''))`),
	]
).enableRLS();

// The versioned SQL migration also owns RLS grants, the roster trigger and RPC functions.
export const authSessions = pgTable("auth_sessions", {
	token_hash: varchar("token_hash", { length: 64 }).primaryKey(),
	user_id: varchar("user_id", { length: 36 }).references(() => users.id, { onDelete: "restrict" }),
	wx_app_id: varchar("wx_app_id", { length: 64 }).notNull(),
	wx_open_id: varchar("wx_open_id", { length: 128 }).notNull(),
	expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
	revoked_at: timestamp("revoked_at", { withTimezone: true }),
	attempts: integer("attempts").notNull().default(0),
	attempt_window_at: timestamp("attempt_window_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
	check("auth_sessions_token_hash_check", sql`${table.token_hash} ~ '^[0-9a-f]{64}$'`),
	check("auth_sessions_attempts_check", sql`${table.attempts} BETWEEN 0 AND 5`),
	uniqueIndex("auth_sessions_onboarding_uidx").on(table.wx_app_id, table.wx_open_id).where(sql`${table.user_id} IS NULL`),
	index("auth_sessions_user_id_idx").on(table.user_id),
	index("auth_sessions_expires_at_idx").on(table.expires_at),
]).enableRLS();

// ================== 课程 ==================
export const courses = pgTable(
	"courses",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		name: varchar("name", { length: 128 }).notNull(),
		teacher_user_id: varchar("teacher_user_id", { length: 36 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("courses_teacher_user_id_idx").on(table.teacher_user_id),
		index("courses_created_at_idx").on(table.created_at),
	]
);

export const teachingGroups = pgTable("teaching_groups", {
	id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
	course_id: varchar("course_id", { length: 36 }).notNull().references(() => courses.id, { onDelete: "cascade" }),
	name: varchar("name", { length: 128 }).notNull(),
	created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
	unique("teaching_groups_course_id_name_key").on(table.course_id, table.name),
	unique("teaching_groups_course_id_id_key").on(table.course_id, table.id),
	check("teaching_groups_name_check", sql`btrim(${table.name}) <> ''`),
]).enableRLS();

// ================== 教学班名单 ==================
export const courseRoster = pgTable(
	"course_roster",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		course_id: varchar("course_id", { length: 36 })
			.notNull()
			.references(() => courses.id, { onDelete: "cascade" }),
		student_no: varchar("student_no", { length: 64 }).notNull(),
		student_name: varchar("student_name", { length: 64 }).notNull(),
		group_id: varchar("group_id", { length: 36 }).notNull(),
		binding_code: varchar("binding_code", { length: 32 }), // 一次性绑定码（演示用明文，生产应收敛为哈希）
		linked_user_id: varchar("linked_user_id", { length: 36 })
			.references(() => users.id, { onDelete: "set null" }),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("course_roster_course_id_idx").on(table.course_id),
		index("course_roster_student_no_idx").on(table.student_no),
		index("course_roster_linked_user_id_idx").on(table.linked_user_id),
		index("course_roster_group_idx").on(table.group_id),
		foreignKey({ name: "course_roster_group_fk", columns: [table.course_id, table.group_id],
			foreignColumns: [teachingGroups.course_id, teachingGroups.id] }),
		uniqueIndex("course_roster_binding_code_uidx").on(table.binding_code),
		uniqueIndex("course_roster_unique_course_student").on(table.course_id, table.student_no),
	]
);

// ================== 签到任务 ==================
export const attendanceTasks = pgTable(
	"attendance_tasks",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		course_id: varchar("course_id", { length: 36 })
			.notNull()
			.references(() => courses.id, { onDelete: "cascade" }),
		created_by: varchar("created_by", { length: 36 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mode: varchar("mode", { length: 20 }).notNull().default("normal"), // normal | quick
		start_at: timestamp("start_at", { withTimezone: true }).notNull(),
		normal_end_at: timestamp("normal_end_at", { withTimezone: true }),
		end_at: timestamp("end_at", { withTimezone: true }).notNull(),
		ended_at: timestamp("ended_at", { withTimezone: true }),
		group_snapshot: jsonb("group_snapshot").$type<Array<{ id: string; name: string }>>().notNull().default(sql`'[]'::jsonb`),
		status: varchar("status", { length: 20 }).notNull().default("active"), // active | ended | legacy cancelled
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("attendance_tasks_course_id_idx").on(table.course_id),
		index("attendance_tasks_created_by_idx").on(table.created_by),
		index("attendance_tasks_status_idx").on(table.status),
		index("attendance_tasks_created_at_idx").on(table.created_at),
	]
);

// ================== 签到参与者（任务创建时快照名单） ==================
export const attendanceParticipants = pgTable(
	"attendance_participants",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		task_id: varchar("task_id", { length: 36 })
			.notNull()
			.references(() => attendanceTasks.id, { onDelete: "cascade" }),
		student_no: varchar("student_no", { length: 64 }).notNull(),
		student_name: varchar("student_name", { length: 64 }).notNull(),
		group_id: varchar("group_id", { length: 36 }),
		group_name: varchar("group_name", { length: 128 }),
		course_roster_id: varchar("course_roster_id", { length: 36 })
			.references(() => courseRoster.id, { onDelete: "set null" }),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("attendance_participants_task_id_idx").on(table.task_id),
		index("attendance_participants_student_no_idx").on(table.student_no),
		index("attendance_participants_roster_id_idx").on(table.course_roster_id),
		uniqueIndex("attendance_participants_unique_task_student").on(table.task_id, table.student_no),
	]
);

// ================== 签到记录 ==================
export const attendanceRecords = pgTable(
	"attendance_records",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		task_id: varchar("task_id", { length: 36 })
			.notNull()
			.references(() => attendanceTasks.id, { onDelete: "cascade" }),
		student_no: varchar("student_no", { length: 64 }).notNull(),
		status: varchar("status", { length: 20 }).notNull().default("signed"), // present | late | excused | absent, plus legacy values
		signed_at: timestamp("signed_at", { withTimezone: true }),
		makeup_at: timestamp("makeup_at", { withTimezone: true }),
		makeup_by: varchar("makeup_by", { length: 36 })
			.references(() => users.id, { onDelete: "set null" }),
		makeup_reason: varchar("makeup_reason", { length: 256 }),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp("updated_at", { withTimezone: true }),
	},
	(table) => [
		index("attendance_records_task_id_idx").on(table.task_id),
		index("attendance_records_student_no_idx").on(table.student_no),
		index("attendance_records_status_idx").on(table.status),
		uniqueIndex("attendance_records_unique_task_student").on(table.task_id, table.student_no),
	]
);

// ================== 操作审计日志 ==================
export const operationLogs = pgTable(
	"operation_logs",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		operator_user_id: varchar("operator_user_id", { length: 36 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		action: varchar("action", { length: 64 }).notNull(), // create_course / import_roster / create_task / sign_in / makeup
		task_id: varchar("task_id", { length: 36 }),
		student_no: varchar("student_no", { length: 64 }),
		details: jsonb("details"),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("operation_logs_operator_idx").on(table.operator_user_id),
		index("operation_logs_task_id_idx").on(table.task_id),
		index("operation_logs_created_at_idx").on(table.created_at),
	]
);
