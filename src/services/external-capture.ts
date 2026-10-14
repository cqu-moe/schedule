import type { ExternalSourceType } from "../db/schema";
import type { CourseEntry } from "./cqu-api";
import { generateCoursesIcs, mergeIcs } from "./ics";
import type { SyncResult } from "./sync";

const MAX_METADATA_LENGTH = 256;
const MAX_COURSE_TEXT_LENGTH = 512;
const MAX_TEACHING_WEEK_BITS = 64;
const MAX_PERIOD_BITS = 14;

export type ExternalCaptureQuality = "complete" | "partial" | "empty";
export type ExternalCaptureErrorCode =
  | "UNSUPPORTED_SOURCE_TYPE"
  | "INVALID_CAPTURE_PAYLOAD"
  | "TARGET_MISMATCH";

export interface ExternalCaptureResult {
  session: {
    id: string;
    name: string;
    beginDate: string;
  };
  sourceName: string;
  result: SyncResult;
  quality: ExternalCaptureQuality;
  skippedCount: number;
  courses: CourseEntry[];
}

export class ExternalCaptureError extends Error {
  readonly code: ExternalCaptureErrorCode;

  constructor(code: ExternalCaptureErrorCode, message: string) {
    super(message);
    this.name = "ExternalCaptureError";
    this.code = code;
  }
}

interface ExpectedSource {
  sourceType: ExternalSourceType;
  sourceId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnsupportedArrays(value: Record<string, unknown>, allowedKey?: string): void {
  for (const [key, property] of Object.entries(value)) {
    if (key !== allowedKey && Array.isArray(property)) {
      throw new ExternalCaptureError(
        "INVALID_CAPTURE_PAYLOAD",
        "The external capture payload contains unsupported timetable data.",
      );
    }
  }
}

function isSafeText(
  value: unknown,
  maxLength: number,
): value is string {
  return typeof value === "string" &&
    value.length <= maxLength &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function requireSafeText(
  value: unknown,
  maxLength: number,
): string {
  if (!isSafeText(value, maxLength)) {
    throw new ExternalCaptureError(
      "INVALID_CAPTURE_PAYLOAD",
      "The external capture payload is invalid.",
    );
  }
  return value;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function parseBitmap(value: unknown, maxLength: number): number[] {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return [];
  }
  if (!/^[01]+$/.test(value)) return [];

  const enabled: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "1") enabled.push(index + 1);
  }
  return enabled;
}

function contiguousRanges(values: number[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = values[0];
  let previous = values[0];

  for (const value of values.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    ranges.push({ start, end: previous });
    start = value;
    previous = value;
  }
  if (start !== undefined) ranges.push({ start, end: previous });
  return ranges;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" || value.length > MAX_COURSE_TEXT_LENGTH ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return null;
  }
  return value;
}

function ownsAdminClassRow(row: Record<string, unknown>, sourceId: string): boolean {
  const assignments = row.assignTeachingObject;
  if (!Array.isArray(assignments)) return false;

  return assignments.some((assignment) =>
    isPlainObject(assignment) && assignment.adminClassId === sourceId,
  );
}

function courseKey(course: CourseEntry): string {
  return JSON.stringify([
    course.name,
    course.lecturer,
    course.room,
    course.position,
    course.day_of_week,
    course.start_session,
    course.end_session,
    course.weeks,
    course.experiment_name ?? null,
  ]);
}

function buildExternalCoursesIcs(
  courses: CourseEntry[],
  semesterStart: string,
  baseNamespace: string,
): string {
  // Identity belongs to one occurrence, not the full semester row. Keep the
  // existing summary/time UID contract when weeks, room or lecturer change.
  const occurrences = new Map<string, Map<string, CourseEntry>>();
  for (const course of courses) {
    for (const week of course.weeks) {
      const occurrence = { ...course, weeks: [week] };
      const identity = JSON.stringify([course.name, course.experiment_name ?? null,
        week, course.day_of_week, course.start_session, course.end_session]);
      const variants = occurrences.get(identity) ?? new Map<string, CourseEntry>();
      variants.set(courseKey(occurrence), occurrence);
      occurrences.set(identity, variants);
    }
  }
  const calendars = [...occurrences.values()].flatMap((variants) =>
    // The provider has no occurrence ID. A deterministic ordinal preserves
    // distinct simultaneous rows without making mutable details part of UID.
    [...variants.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([, course], index) => generateCoursesIcs([course], semesterStart,
        !course.experiment_name && index === 0 ? baseNamespace
          : `${baseNamespace}:${JSON.stringify([course.experiment_name ?? null, index])}`)),
  );

  while (calendars.length > 1) {
    const merged: string[] = [];
    for (let index = 0; index < calendars.length; index += 2) {
      if (index + 1 === calendars.length) {
        merged.push(calendars[index]);
      } else {
        merged.push(mergeIcs(calendars[index], calendars[index + 1]));
      }
    }
    calendars.splice(0, calendars.length, ...merged);
  }

  return calendars[0] ?? generateCoursesIcs([], semesterStart, baseNamespace);
}

function ownsExternalRow(row: Record<string, unknown>, sourceId: string, sourceType: ExternalSourceType): boolean {
  switch (sourceType) {
    case "admin_class": return ownsAdminClassRow(row, sourceId);
    case "course": return row.classId === sourceId;
    case "instructor": return Array.isArray(row.instructorIdList) && row.instructorIdList.includes(sourceId);
    case "room":
    case "laboratory": return row.roomId === sourceId;
    default: return false;
  }
}

function parseExternalRow(
  row: unknown,
  sourceId: string,
  maxSection: number,
  sourceType: ExternalSourceType,
): CourseEntry[] {
  if (!isPlainObject(row) || !ownsExternalRow(row, sourceId, sourceType)) {
    throw new ExternalCaptureError(
      "TARGET_MISMATCH",
      "The external capture target does not own every timetable row.",
    );
  }

  const name = row.courseName;
  if (!isSafeText(name, MAX_COURSE_TEXT_LENGTH)) return [];

  const dayOfWeek = row.weekDay;
  if (typeof dayOfWeek !== "number" || !Number.isInteger(dayOfWeek) ||
      dayOfWeek < 1 || dayOfWeek > 7) {
    return [];
  }

  const weeks = parseBitmap(row.teachingWeek, MAX_TEACHING_WEEK_BITS);
  const sessions = parseBitmap(row.period, MAX_PERIOD_BITS);
  if (weeks.length === 0 || sessions.length === 0) return [];
  if (sessions.some((session) => session > maxSection)) return [];

  const lecturer = optionalText(row.instructorName);
  const room = optionalText(row.roomName);
  const position = optionalText(row.position);
  const campusName = optionalText(row.campusName);
  const experimentName = optionalText(row.exprProjectName);
  if (lecturer === null || room === null || position === null ||
      campusName === null || experimentName === null) {
    return [];
  }

  const trimmedExperimentName = experimentName.trim();
  const base = {
    name,
    lecturer,
    room,
    position: position || campusName,
    day_of_week: dayOfWeek,
    weeks,
    ...(trimmedExperimentName ? { experiment_name: trimmedExperimentName } : {}),
  };

  return contiguousRanges(sessions).map((range) => ({
    ...base,
    start_session: range.start,
    end_session: range.end,
  }));
}

export function buildExternalCaptureResult(
  payload: unknown,
  expected: ExpectedSource,
): ExternalCaptureResult {
  if (expected.sourceType !== "admin_class" && expected.sourceType !== "instructor" && expected.sourceType !== "room" && expected.sourceType !== "laboratory" && expected.sourceType !== "course") {
    throw new ExternalCaptureError(
      "UNSUPPORTED_SOURCE_TYPE",
      "This external source type is not supported yet.",
    );
  }

  const sourceId = requireSafeText(expected.sourceId, MAX_METADATA_LENGTH);
  if (!isPlainObject(payload)) {
    throw new ExternalCaptureError(
      "INVALID_CAPTURE_PAYLOAD",
      "The external capture payload is invalid.",
    );
  }
  if (payload.contractVersion !== 1 || payload.sourceType !== expected.sourceType) {
    throw new ExternalCaptureError(
      "INVALID_CAPTURE_PAYLOAD",
      "The external capture payload is invalid.",
    );
  }

  const target = payload.target;
  const session = payload.session;
  const timetable = payload.timetable;
  if (!isPlainObject(target) || !isPlainObject(session) || !isPlainObject(timetable)) {
    throw new ExternalCaptureError(
      "INVALID_CAPTURE_PAYLOAD",
      "The external capture payload is invalid.",
    );
  }
  rejectUnsupportedArrays(payload);
  rejectUnsupportedArrays(target);
  rejectUnsupportedArrays(session);

  const targetId = requireSafeText(target.id, MAX_METADATA_LENGTH);
  const targetName = requireSafeText(target.name, MAX_METADATA_LENGTH);
  if (targetId !== sourceId) {
    throw new ExternalCaptureError(
      "TARGET_MISMATCH",
      "The external capture target does not match the selected source.",
    );
  }

  const sessionId = requireSafeText(session.id, MAX_METADATA_LENGTH);
  const sessionName = requireSafeText(session.name, MAX_METADATA_LENGTH);
  const beginDate = requireSafeText(session.beginDate, 10);
  if (!isCalendarDate(beginDate)) {
    throw new ExternalCaptureError(
      "INVALID_CAPTURE_PAYLOAD",
      "The external capture payload has an invalid semester start date.",
    );
  }

  const maxSection = timetable.maxSection;
  if (typeof maxSection !== "number" || !Number.isInteger(maxSection) ||
      maxSection < 1 || maxSection > MAX_PERIOD_BITS) {
    throw new ExternalCaptureError(
      "INVALID_CAPTURE_PAYLOAD",
      "The external capture payload is invalid.",
    );
  }
  const rows = timetable.classTimetableVOList;
  if (!Array.isArray(rows)) {
    throw new ExternalCaptureError(
      "INVALID_CAPTURE_PAYLOAD",
      "The external capture payload is invalid.",
    );
  }
  rejectUnsupportedArrays(timetable, "classTimetableVOList");

  const courses: CourseEntry[] = [];
  const seen = new Set<string>();
  const unverifiedItemCount = timetable.unverifiedItemCount === undefined ? 0 : timetable.unverifiedItemCount;
  if (typeof unverifiedItemCount !== "number" || !Number.isSafeInteger(unverifiedItemCount) || unverifiedItemCount < 0 || unverifiedItemCount > 100_000) {
    throw new ExternalCaptureError("INVALID_CAPTURE_PAYLOAD", "The external capture completeness information is invalid.");
  }
  let skippedCount = unverifiedItemCount;

  for (const row of rows) {
    const parsed = parseExternalRow(row, sourceId, maxSection, expected.sourceType);
    if (parsed.length === 0) {
      skippedCount += 1;
      continue;
    }
    for (const course of parsed) {
      const key = courseKey(course);
      if (seen.has(key)) continue;
      seen.add(key);
      courses.push(course);
    }
  }

  const quality: ExternalCaptureQuality = rows.length === 0 && skippedCount === 0
    ? "empty"
    : courses.length > 0 && skippedCount === 0
      ? "complete"
      : "partial";
  const icsNamespace = `external:${expected.sourceType}:${sourceId}`;

  return {
    session: { id: sessionId, name: sessionName, beginDate },
    sourceName: targetName,
    result: {
      icsContent: buildExternalCoursesIcs(courses, beginDate, icsNamespace),
      coursesJson: JSON.stringify(courses),
      examsJson: null,
      semesterStart: beginDate,
    },
    quality,
    skippedCount,
    courses,
  };
}
