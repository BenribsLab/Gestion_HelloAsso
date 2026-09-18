import { z } from "zod";
import { categoryForBirthDate, getCategoryDefinitions, getCategorySeason } from "./categories.js";
import type { Database } from "./db.js";
import { fencingCategoryError, normalizeBirthDate } from "./fencing-category.js";

export type SchoolHoliday = {
  name: string;
  startDate: string;
  endDate: string;
};

const calendarResponseSchema = z.object({
  results: z.array(z.object({
    description: z.string(),
    population: z.string().nullish(),
    start_date: z.string(),
    end_date: z.string(),
    location: z.string(),
    zones: z.string().nullish()
  })).default([])
});

const calendarCache = new Map<string, { expiresAt: number; holidays: SchoolHoliday[] }>();

export async function getSchoolHolidays(startDate: string, endDate: string) {
  const cacheKey = `${startDate}:${endDate}`;
  const cached = calendarCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.holidays;

  const where = `location = "Versailles" AND end_date >= date'${startDate}' AND start_date <= date'${endDate}'`;
  const search = new URLSearchParams({ limit: "100", where, order_by: "start_date" });
  const response = await fetch(
    `https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/` +
      `fr-en-calendrier-scolaire/records?${search}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
  );
  if (!response.ok) throw new Error("Le calendrier scolaire officiel n'est pas disponible.");

  const parsed = calendarResponseSchema.parse(await response.json());
  const unique = new Map<string, SchoolHoliday>();
  for (const record of parsed.results) {
    if (record.population === "Enseignants") continue;
    const start = parisDate(record.start_date);
    let end = parisDate(record.end_date);
    if (end <= start) end = addDays(end, 1);
    const holiday = { name: record.description, startDate: start, endDate: end };
    unique.set(`${holiday.name}\0${holiday.startDate}\0${holiday.endDate}`, holiday);
  }
  const holidays = [...unique.values()].sort((left, right) => left.startDate.localeCompare(right.startDate));
  calendarCache.set(cacheKey, { expiresAt: Date.now() + 6 * 60 * 60 * 1_000, holidays });
  return holidays;
}

export async function getAttendanceSheet(
  database: Database,
  groupId: string,
  startDate: string,
  endDate: string
) {
  const seasonReference = new Date(`${startDate}T12:00:00Z`);
  const [groupResult, schedulesResult, membersResult, attendanceResult, holidays, categoryDefinitions, categorySeason] = await Promise.all([
    database.query<{ id: string; name: string; createdAt: Date }>(
      `SELECT id, name, created_at AS "createdAt" FROM groups WHERE id = $1`,
      [groupId]
    ),
    database.query<{ weekday: number; startTime: string; endTime: string }>(
      `SELECT weekday, to_char(start_time, 'HH24:MI') AS "startTime",
              to_char(end_time, 'HH24:MI') AS "endTime"
       FROM group_training_schedules WHERE group_id = $1
       ORDER BY weekday, start_time`,
      [groupId]
    ),
    database.query<{ id: string; firstName: string; lastName: string; birthDate: string | null }>(
      `SELECT m.id,
              COALESCE(NULLIF(m.local_overrides->>'firstName', ''), m.first_name) AS "firstName",
              COALESCE(NULLIF(m.local_overrides->>'lastName', ''), m.last_name) AS "lastName",
              CASE WHEN m.local_overrides ? 'birthDate'
                THEN m.local_overrides->>'birthDate'
                ELSE COALESCE(to_char(m.birth_date, 'YYYY-MM-DD'), birth.value)
              END AS "birthDate"
       FROM members m
       JOIN member_groups mg ON mg.member_id = m.id
       LEFT JOIN LATERAL (
         SELECT field_value.value #>> '{}' AS value
         FROM jsonb_each(COALESCE(m.profile_data, '{}'::jsonb)) field_value
         JOIN helloasso_fields field ON field.field_key = field_value.key
         WHERE field.field_type = 'Date' AND field.label ILIKE '%naissance%'
         LIMIT 1
       ) birth ON true
       WHERE mg.group_id = $1 AND m.status = 'active'
       ORDER BY m.last_name, m.first_name`,
      [groupId]
    ),
    database.query<{ memberId: string; date: string; startTime: string; status: "present" | "absent" | "excused" }>(
      `SELECT member_id AS "memberId", to_char(session_date, 'YYYY-MM-DD') AS date,
              to_char(start_time, 'HH24:MI') AS "startTime", status
       FROM attendance_records
       WHERE group_id = $1 AND session_date BETWEEN $2::date AND $3::date`,
      [groupId, startDate, endDate]
    ),
    getSchoolHolidays(startDate, endDate),
    getCategoryDefinitions(database, seasonReference),
    getCategorySeason(database, seasonReference)
  ]);
  const group = groupResult.rows[0];
  if (!group) return null;

  const sessions: Array<{ date: string; startTime: string; endTime: string }> = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    if (holidays.some((holiday) => date >= holiday.startDate && date < holiday.endDate)) continue;
    const weekday = isoWeekday(date);
    for (const schedule of schedulesResult.rows.filter((entry) => entry.weekday === weekday)) {
      sessions.push({ date, startTime: schedule.startTime, endTime: schedule.endTime });
    }
  }

  return {
    group,
    schedules: schedulesResult.rows,
    members: membersResult.rows.map((member) => {
      const birthDate = normalizeBirthDate(member.birthDate);
      return {
        ...member,
        birthDate,
        fencingCategory: categoryForBirthDate(birthDate, categoryDefinitions, seasonReference),
        categoryError: fencingCategoryError(birthDate, seasonReference)
      };
    }),
    fencingSeason: categorySeason.label,
    holidays,
    sessions,
    attendance: attendanceResult.rows,
    startDate,
    endDate
  };
}

export async function saveAttendance(
  database: Database,
  groupId: string,
  startDate: string,
  endDate: string,
  records: Array<{
    memberId: string;
    date: string;
    startTime: string;
    status: "present" | "absent" | "excused";
  }>
) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const groupResult = await client.query("SELECT 1 FROM groups WHERE id = $1", [groupId]);
    if (groupResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `DELETE FROM attendance_records
       WHERE group_id = $1 AND session_date BETWEEN $2::date AND $3::date`,
      [groupId, startDate, endDate]
    );
    for (const record of records) {
      await client.query(
        `INSERT INTO attendance_records
           (group_id, member_id, session_date, start_time, status)
         SELECT $1, $2, $3::date, $4::time, $5
         WHERE EXISTS (
           SELECT 1 FROM member_groups WHERE group_id = $1 AND member_id = $2
         )`,
        [groupId, record.memberId, record.date, record.startTime, record.status]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function parisDate(value: string) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function isoWeekday(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function addDays(date: string, count: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
