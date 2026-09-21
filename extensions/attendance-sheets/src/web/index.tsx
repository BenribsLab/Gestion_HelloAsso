import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";

type HostApi = {
  request<T>(path: string, init?: RequestInit): Promise<T>;
};

type Group = { id: string; name: string; createdAt: string; trainingSchedules: TrainingSchedule[] };
type TrainingSchedule = { weekday: number; startTime: string; endTime: string };
type SchoolHoliday = { name: string; startDate: string; endDate: string };
type AttendanceRecord = { memberId: string; date: string; startTime: string; status: "present" | "absent" | "excused" };
type AttendanceSheet = {
  group: { id: string; name: string; createdAt: string };
  schedules: TrainingSchedule[];
  members: Array<{ id: string; firstName: string; lastName: string; birthDate: string | null; fencingCategory: string | null; categoryError: string | null }>;
  fencingSeason: string | null;
  holidays: SchoolHoliday[];
  sessions: Array<{ date: string; startTime: string; endTime: string }>;
  attendance: AttendanceRecord[];
  startDate: string;
  endDate: string;
};

const EXTENSION_ID = "attendance-sheets";
const VIEW_ELEMENT_NAME = "gu-ext-attendance-sheets";
const PANEL_ELEMENT_NAME = "gu-ext-attendance-sheets-schedule";
const weekdays = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

function Attendance({ host }: { host: HostApi }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const today = new Date().toISOString().slice(0, 10);
  const schoolStartYear = Number(today.slice(5, 7)) >= 8 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
  const schoolStart = `${schoolStartYear}-09-01`;
  const schoolEnd = `${schoolStartYear + 1}-08-31`;
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(addDateDays(today, 42));
  const [holidays, setHolidays] = useState<SchoolHoliday[]>([]);
  const [sheet, setSheet] = useState<AttendanceSheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const coursePeriods = useMemo(() => buildCoursePeriods(schoolStart, schoolEnd, holidays), [schoolStart, schoolEnd, holidays]);

  useEffect(() => {
    void host.request<{ items: Group[] }>("/api/groups")
      .then((result) => setGroups(result.items))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Groupes indisponibles."));
  }, [host]);

  useEffect(() => {
    if (!selectedGroupId && groups[0]) setSelectedGroupId(groups[0].id);
  }, [groups, selectedGroupId]);

  useEffect(() => {
    void host.request<{ items: SchoolHoliday[] }>(
      `/api/school-holidays?startDate=${encodeURIComponent(schoolStart)}&endDate=${encodeURIComponent(schoolEnd)}`
    )
      .then((result) => setHolidays(result.items))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Calendrier indisponible."));
  }, [host, schoolStart, schoolEnd]);

  useEffect(() => {
    if (!selectedGroup || holidays.length === 0) return;
    const period = defaultCoursePeriod(selectedGroup, coursePeriods, today);
    if (period) { setStartDate(period.startDate); setEndDate(period.endDate); }
    setSheet(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId, holidays.length]);

  async function generate() {
    if (!selectedGroupId) return;
    setBusy(true); setError(null); setSheet(null);
    try {
      setSheet(await host.request<AttendanceSheet>(
        `/api/groups/${selectedGroupId}/attendance-sheet?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
      ));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de générer la feuille.");
    } finally { setBusy(false); }
  }

  return <div className="attendance-page">
    <section className="panel attendance-controls no-print">
      <div><p className="eyebrow">Préparation</p><h2>Générer une feuille</h2><p className="muted">Les dates situées pendant les vacances scolaires de la zone C sont automatiquement retirées.</p></div>
      {groups.length === 0 ? <p className="empty-inline">Créez d'abord un groupe.</p> : <div className="attendance-form">
        <label>Groupe<select value={selectedGroupId} onChange={(event) => { setSelectedGroupId(event.target.value); setSheet(null); }}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <label>Période entre deux vacances<select value="" onChange={(event) => { const [start, end] = event.target.value.split("|"); if (start && end) { setStartDate(start); setEndDate(end); setSheet(null); } }}><option value="">Choisir une période…</option>{coursePeriods.map((period) => <option key={`${period.startDate}:${period.endDate}`} value={`${period.startDate}|${period.endDate}`}>{formatShortDate(period.startDate)} → {formatShortDate(period.endDate)}</option>)}</select></label>
        <label>Du<input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setSheet(null); }} /></label>
        <label>Au<input type="date" value={endDate} min={startDate} onChange={(event) => { setEndDate(event.target.value); setSheet(null); }} /></label>
        <button className="primary" type="button" disabled={busy || !selectedGroupId || endDate < startDate} onClick={() => void generate()}>{busy ? "Génération…" : "Générer"}</button>
      </div>}
      {error && <div className="alert error">{error}</div>}
    </section>

    <section className="panel holiday-calendar no-print">
      <div className="section-heading"><div><p className="eyebrow">Calendrier officiel</p><h2>Vacances scolaires — Zone C</h2></div><span className="count-pill">Versailles</span></div>
      <div className="holiday-list">{holidays.map((holiday) => <article key={`${holiday.name}:${holiday.startDate}`}><strong>{holiday.name}</strong><span>{formatShortDate(holiday.startDate)} → {formatShortDate(addDateDays(holiday.endDate, -1))}</span></article>)}</div>
    </section>

    {sheet && <AttendancePrintout host={host} sheet={sheet} />}
  </div>;
}

function AttendancePrintout({ host, sheet }: { host: HostApi; sheet: AttendanceSheet }) {
  const chunks = chunked(sheet.sessions, 9);
  const [records, setRecords] = useState<Map<string, AttendanceRecord>>(
    new Map(sheet.attendance.map((record) => [attendanceKey(record.memberId, record.date, record.startTime), record]))
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function cycle(memberId: string, date: string, startTime: string) {
    const key = attendanceKey(memberId, date, startTime);
    setRecords((current) => {
      const next = new Map(current);
      const status = current.get(key)?.status;
      if (!status) next.set(key, { memberId, date, startTime, status: "present" });
      else if (status === "present") next.set(key, { memberId, date, startTime, status: "absent" });
      else if (status === "absent") next.set(key, { memberId, date, startTime, status: "excused" });
      else next.delete(key);
      return next;
    });
    setMessage(null);
  }

  async function save() {
    setSaving(true); setMessage(null);
    try {
      await host.request(`/api/groups/${sheet.group.id}/attendance`, {
        method: "PUT",
        body: JSON.stringify({ startDate: sheet.startDate, endDate: sheet.endDate, records: [...records.values()] })
      });
      setMessage("Présences enregistrées localement.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Enregistrement impossible.");
    } finally { setSaving(false); }
  }

  return <section className="attendance-result">
    <div className="print-toolbar no-print"><div><strong>{sheet.sessions.length} séance{sheet.sessions.length > 1 ? "s" : ""}</strong><span> · {sheet.members.length} adhérent{sheet.members.length > 1 ? "s" : ""}</span><p>Cliquez sur une case : <b>✓ présent</b> → <b>✕ absent</b> → <b>E excusé</b> → vide.</p>{message && <p className="attendance-message">{message}</p>}</div><div><button className="secondary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Enregistrement…" : "Enregistrer les présences"}</button><button className="primary" type="button" onClick={() => window.print()}>Imprimer / enregistrer en PDF</button></div></div>
    {sheet.sessions.length === 0 ? <div className="panel empty-inline no-print">Aucune séance dans cette période. Vérifiez les créneaux du groupe.</div> : chunks.map((sessions, pageIndex) => <article className="panel attendance-sheet" key={pageIndex}>
      <header><div><p className="eyebrow">Feuille de présence{sheet.fencingSeason ? ` · catégories FFE ${sheet.fencingSeason}` : ""}</p><h2>{sheet.group.name}</h2></div><div className="sheet-period">Du {formatShortDate(sheet.startDate)} au {formatShortDate(sheet.endDate)}</div></header>
      <table><thead><tr><th className="name-column">Adhérent</th>{sessions.map((session) => <th key={`${session.date}:${session.startTime}`}><span>{formatWeekday(session.date)}</span><strong>{formatDayMonth(session.date)}</strong><small>{session.startTime}</small></th>)}</tr></thead>
      <tbody>{sheet.members.map((member) => <tr key={member.id}><td>{member.lastName} {member.firstName}{member.fencingCategory && <small className="sheet-category">{member.fencingCategory}</small>}</td>{sessions.map((session) => {
        const record = records.get(attendanceKey(member.id, session.date, session.startTime));
        return <td className={`attendance-cell ${record?.status ?? ""}`} key={`${member.id}:${session.date}:${session.startTime}`}><button type="button" aria-label={`${member.firstName} ${member.lastName}, ${formatShortDate(session.date)} : ${attendanceStatusLabel(record?.status)}`} onClick={() => cycle(member.id, session.date, session.startTime)}>{attendanceStatusSymbol(record?.status)}</button></td>;
      })}</tr>)}</tbody></table>
      <footer>Page {pageIndex + 1}/{chunks.length}</footer>
    </article>)}
  </section>;
}

function TrainingSchedulesPanel({ host, group, onChanged }: { host: HostApi; group: Group; onChanged: () => void }) {
  const [schedules, setSchedules] = useState<TrainingSchedule[]>(group.trainingSchedules);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = schedules.some((schedule) => schedule.endTime <= schedule.startTime);

  useEffect(() => setSchedules(group.trainingSchedules), [group]);

  function change(index: number, patch: Partial<TrainingSchedule>) {
    setSchedules((current) => current.map((schedule, position) => position === index ? { ...schedule, ...patch } : schedule));
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      await host.request(`/api/groups/${group.id}/schedules`, {
        method: "PUT",
        body: JSON.stringify({ schedules })
      });
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible d'enregistrer les créneaux.");
    } finally { setSaving(false); }
  }

  return <div className="training-schedules">
    {error && <div className="alert error">{error}</div>}
    <div className="subsection-heading"><div><h3>Jours et heures d'entraînement</h3><p>Ajoutez tous les créneaux hebdomadaires de ce groupe.</p></div><button className="secondary" type="button" onClick={() => setSchedules((current) => [...current, { weekday: 3, startTime: "18:00", endTime: "19:30" }])}>Ajouter un créneau</button></div>
    {schedules.length === 0 ? <p className="empty-inline">Aucun créneau configuré.</p> : <div className="schedule-list">{schedules.map((schedule, index) => <div className="schedule-row" key={`${index}:${schedule.weekday}:${schedule.startTime}`}>
      <label>Jour<select value={schedule.weekday} onChange={(event) => change(index, { weekday: Number(event.target.value) })}>{weekdays.map((day, dayIndex) => <option key={day} value={dayIndex + 1}>{day}</option>)}</select></label>
      <label>Début<input type="time" value={schedule.startTime} onChange={(event) => change(index, { startTime: event.target.value })} /></label>
      <label>Fin<input type="time" value={schedule.endTime} onChange={(event) => change(index, { endTime: event.target.value })} /></label>
      <button className="danger-link" type="button" onClick={() => setSchedules((current) => current.filter((_, position) => position !== index))}>Supprimer</button>
    </div>)}</div>}
    <div className="editor-actions"><button className="primary" type="button" disabled={saving || invalid} onClick={() => void save()}>{saving ? "Enregistrement…" : "Enregistrer les créneaux"}</button></div>
  </div>;
}

function attendanceKey(memberId: string, date: string, startTime: string) {
  return `${memberId}:${date}:${startTime}`;
}

function attendanceStatusSymbol(status?: AttendanceRecord["status"]) {
  if (status === "present") return "✓";
  if (status === "absent") return "✕";
  if (status === "excused") return "E";
  return "";
}

function attendanceStatusLabel(status?: AttendanceRecord["status"]) {
  if (status === "present") return "présent";
  if (status === "absent") return "absent";
  if (status === "excused") return "excusé";
  return "non renseigné";
}

function buildCoursePeriods(schoolStart: string, schoolEnd: string, holidays: SchoolHoliday[]) {
  const periods: Array<{ startDate: string; endDate: string }> = [];
  let cursor = schoolStart;
  for (const holiday of holidays) {
    const end = addDateDays(holiday.startDate, -1);
    if (end >= cursor) periods.push({ startDate: cursor, endDate: end });
    if (holiday.endDate > cursor) cursor = holiday.endDate;
  }
  if (cursor <= schoolEnd) periods.push({ startDate: cursor, endDate: schoolEnd });
  return periods;
}

function defaultCoursePeriod(group: Group, periods: Array<{ startDate: string; endDate: string }>, today: string) {
  const createdAt = group.createdAt.slice(0, 10);
  const currentOrNext = periods.find((period) => period.endDate >= today);
  if (!currentOrNext) return null;
  return { startDate: createdAt > currentOrNext.startDate ? createdAt : currentOrNext.startDate, endDate: currentOrNext.endDate };
}

function chunked<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function addDateDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatShortDate(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function formatWeekday(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function formatDayMonth(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

class AttendanceSheetsViewElement extends HTMLElement {
  hostApi?: HostApi;
  private root: Root | null = null;

  connectedCallback() {
    if (!this.hostApi) throw new Error("hostApi n'a pas été fourni à l'élément du module.");
    this.root = createRoot(this);
    this.root.render(<Attendance host={this.hostApi} />);
  }

  disconnectedCallback() {
    const root = this.root;
    this.root = null;
    queueMicrotask(() => root?.unmount());
  }
}

class AttendanceSchedulePanelElement extends HTMLElement {
  hostApi?: HostApi;
  viewPayload?: unknown;
  private root: Root | null = null;

  connectedCallback() {
    if (!this.hostApi) throw new Error("hostApi n'a pas été fourni à l'élément du module.");
    const group = this.viewPayload as Group;
    this.root = createRoot(this);
    this.root.render(
      <TrainingSchedulesPanel
        host={this.hostApi}
        group={group}
        onChanged={() => this.dispatchEvent(new CustomEvent("gu:data-changed", { bubbles: true }))}
      />
    );
  }

  disconnectedCallback() {
    const root = this.root;
    this.root = null;
    queueMicrotask(() => root?.unmount());
  }
}

if (!customElements.get(VIEW_ELEMENT_NAME)) customElements.define(VIEW_ELEMENT_NAME, AttendanceSheetsViewElement);
if (!customElements.get(PANEL_ELEMENT_NAME)) customElements.define(PANEL_ELEMENT_NAME, AttendanceSchedulePanelElement);

window.__GU_HOST__?.registerView({
  extensionId: EXTENSION_ID,
  label: "Feuilles de présence",
  element: VIEW_ELEMENT_NAME
});

window.__GU_HOST__?.registerGroupPanel({
  extensionId: EXTENSION_ID,
  label: "Créneaux",
  element: PANEL_ELEMENT_NAME
});
