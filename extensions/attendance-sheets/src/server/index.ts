import { z } from "zod";
import type { ExtensionServerHost } from "@gu/extension-host";
import { getAttendanceSheet, getSchoolHolidays, saveAttendance } from "./attendance.js";

const groupIdSchema = z.object({ groupId: z.uuid() });
const scheduleSelectionSchema = z.object({
  schedules: z.array(z.object({
    weekday: z.number().int().min(1).max(7),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  }).refine((schedule) => schedule.endTime > schedule.startTime, {
    message: "L'heure de fin doit suivre l'heure de début."
  })).max(20)
});
const attendanceQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
}).refine((period) => period.endDate >= period.startDate, {
  message: "La période est invalide."
}).refine((period) => {
  const days = (Date.parse(period.endDate) - Date.parse(period.startDate)) / 86_400_000;
  return days <= 730;
}, { message: "La période ne peut pas dépasser deux ans." });
const attendanceSaveSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  records: z.array(z.object({
    memberId: z.uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    status: z.enum(["present", "absent", "excused"])
  })).max(20_000)
}).refine((input) => input.endDate >= input.startDate && input.records.every(
  (record) => record.date >= input.startDate && record.date <= input.endDate
), { message: "Les présences ne correspondent pas à la période." });

export default function register(host: ExtensionServerHost) {
  const database = host.database;

  // Le noyau n'interroge plus group_training_schedules : il demande ces créneaux ici pour
  // enrichir /api/groups, et reçoit [] tant que ce module est absent ou désactivé.
  host.contracts.registerGroupScheduleProvider({
    extensionId: host.id,
    loadContext: (db) => db.query<{ groupId: string; weekday: number; startTime: string; endTime: string }>(`
      SELECT group_id AS "groupId", weekday,
             to_char(start_time, 'HH24:MI') AS "startTime",
             to_char(end_time, 'HH24:MI') AS "endTime"
      FROM group_training_schedules
      ORDER BY group_id, weekday, start_time
    `),
    schedulesByGroup: (result) => {
      const byGroup = new Map<string, Array<{ weekday: number; startTime: string; endTime: string }>>();
      for (const row of result.rows) {
        const schedules = byGroup.get(row.groupId) ?? [];
        schedules.push({ weekday: row.weekday, startTime: row.startTime, endTime: row.endTime });
        byGroup.set(row.groupId, schedules);
      }
      return byGroup;
    }
  });

  host.route("PUT", "/api/groups/:groupId/schedules", {}, async (request, reply) => {
    const { groupId } = groupIdSchema.parse(request.params);
    const input = scheduleSelectionSchema.parse(request.body);
    const schedules = [...new Map(input.schedules.map((schedule) => [
      `${schedule.weekday}:${schedule.startTime}:${schedule.endTime}`,
      schedule
    ])).values()];
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const groupResult = await client.query("SELECT 1 FROM groups WHERE id = $1", [groupId]);
      if (groupResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ message: "Ce groupe n'existe pas." });
      }
      await client.query("DELETE FROM group_training_schedules WHERE group_id = $1", [groupId]);
      for (const schedule of schedules) {
        await client.query(
          `INSERT INTO group_training_schedules (group_id, weekday, start_time, end_time)
           VALUES ($1, $2, $3, $4)`,
          [groupId, schedule.weekday, schedule.startTime, schedule.endTime]
        );
      }
      await client.query("COMMIT");
      return { groupId, schedules };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  host.route("GET", "/api/school-holidays", {}, async (request) => {
    const period = attendanceQuerySchema.parse(request.query);
    return { zone: "C", academy: "Versailles", items: await getSchoolHolidays(period.startDate, period.endDate) };
  });

  host.route("GET", "/api/groups/:groupId/attendance-sheet", {}, async (request, reply) => {
    const { groupId } = groupIdSchema.parse(request.params);
    const period = attendanceQuerySchema.parse(request.query);
    const categoryContext = await host.contracts.loadMemberCategoryContext(
      database,
      (id) => host.isExtensionEnabled(id),
      new Date(`${period.startDate}T12:00:00Z`)
    );
    const sheet = await getAttendanceSheet(database, groupId, period.startDate, period.endDate, categoryContext);
    if (!sheet) return reply.code(404).send({ message: "Ce groupe n'existe pas." });
    return sheet;
  });

  host.route("PUT", "/api/groups/:groupId/attendance", {}, async (request, reply) => {
    const { groupId } = groupIdSchema.parse(request.params);
    const input = attendanceSaveSchema.parse(request.body);
    const saved = await saveAttendance(database, groupId, input.startDate, input.endDate, input.records);
    if (!saved) return reply.code(404).send({ message: "Ce groupe n'existe pas." });
    return { savedCount: input.records.length };
  });
}
