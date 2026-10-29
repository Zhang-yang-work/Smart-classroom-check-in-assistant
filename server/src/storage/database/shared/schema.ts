import { pgTable, serial, varchar, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core"
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
		teacher_code: varchar("teacher_code", { length: 64 }), // 教师口令，学生为 null
		token: varchar("token", { length: 64 }), // 会话 token
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("users_token_idx").on(table.token),
		index("users_role_idx").on(table.role),
		index("users_student_no_idx").on(table.student_no),
	]
);

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

// ================== 课程名单（绑定码一次性） ==================
export const courseRoster = pgTable(
	"course_roster",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		course_id: varchar("course_id", { length: 36 })
			.notNull()
			.references(() => courses.id, { onDelete: "cascade" }),
		student_no: varchar("student_no", { length: 64 }).notNull(),
		student_name: varchar("student_name", { length: 64 }).notNull(),
		binding_code: varchar("binding_code", { length: 32 }), // 一次性绑定码（演示用明文，生产应收敛为哈希）
		linked_user_id: varchar("linked_user_id", { length: 36 })
			.references(() => users.id, { onDelete: "set null" }),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("course_roster_course_id_idx").on(table.course_id),
		index("course_roster_student_no_idx").on(table.student_no),
		index("course_roster_linked_user_id_idx").on(table.linked_user_id),
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
		end_at: timestamp("end_at", { withTimezone: true }).notNull(),
		status: varchar("status", { length: 20 }).notNull().default("active"), // active | cancelled
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
		status: varchar("status", { length: 20 }).notNull().default("signed"), // signed | makeup
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