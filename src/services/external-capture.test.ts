import { describe, expect, it } from "vitest";
import { EMPTY_ICS } from "./ics";
import { buildExternalCaptureResult, ExternalCaptureError } from "./external-capture";

const payload = {
  contractVersion: 1,
  sourceType: "admin_class",
  target: {
    id: "SYNTH-ADMIN-001",
    name: "Synthetic Admin Class 001",
  },
  session: {
    id: "SYNTH-CURRENT-SESSION",
    name: "Synthetic Current Session",
    beginDate: "2026-09-07",
  },
  timetable: {
    maxSection: 12,
    classTimetableVOList: [
      {
        courseName: "Synthetic Course A",
        instructorName: "Synthetic Instructor A",
        roomName: "SYNTH-ROOM-001",
        position: "Synthetic Position",
        campusName: "Synthetic Campus",
        weekDay: 1,
        teachingWeek: "1101",
        period: "11000000000000",
        exprProjectName: null,
        assignTeachingObject: [{ adminClassId: "SYNTH-ADMIN-001" }],
        secretField: "must-not-leak",
      },
    ],
  },
};


function captureError(
  payload: unknown,
  expected = { sourceType: "admin_class" as const, sourceId: "SYNTH-ADMIN-001" },
): ExternalCaptureError {
  try {
    buildExternalCaptureResult(payload, expected);
  } catch (error) {
    if (error instanceof ExternalCaptureError) return error;
    throw error;
  }
  throw new Error("expected buildExternalCaptureResult to fail");
}

describe("buildExternalCaptureResult", () => {
  it("projects a whitelisted admin-class capture into stable schedule output", () => {
    const captured = buildExternalCaptureResult(payload, {
      sourceType: "admin_class",
      sourceId: "SYNTH-ADMIN-001",
    });

    expect(captured.session).toEqual({
      id: "SYNTH-CURRENT-SESSION",
      name: "Synthetic Current Session",
      beginDate: "2026-09-07",
    });
    expect(captured.sourceName).toBe("Synthetic Admin Class 001");
    expect(captured.quality).toBe("complete");
    expect(captured.skippedCount).toBe(0);
    expect(captured.courses).toEqual([
      {
        name: "Synthetic Course A",
        lecturer: "Synthetic Instructor A",
        room: "SYNTH-ROOM-001",
        position: "Synthetic Position",
        day_of_week: 1,
        start_session: 1,
        end_session: 2,
        weeks: [1, 2, 4],
        experiment_name: undefined,
      },
    ]);
    expect(captured.result.semesterStart).toBe("2026-09-07");
    expect(captured.result.examsJson).toBeNull();
    expect(JSON.parse(captured.result.coursesJson ?? "null")).toEqual(captured.courses);
    expect(captured.result.icsContent).not.toContain("secretField");
    expect(captured.result.icsContent).not.toContain("must-not-leak");
    expect(captured.result.icsContent).toContain("SUMMARY:Synthetic Course A");
    const differentSessionMetadata = structuredClone(payload);
    differentSessionMetadata.session.id = "SYNTH-OTHER-SESSION";
    differentSessionMetadata.session.name = "Synthetic Other Session";
    expect(captured.result.icsContent).toBe(buildExternalCaptureResult(
      differentSessionMetadata,
      { sourceType: "admin_class", sourceId: "SYNTH-ADMIN-001" },
    ).result.icsContent);
  });

  it("keeps valid owned rows when another owned row has unverifiable content", () => {
    const partialPayload = structuredClone(payload);
    const rows = partialPayload.timetable.classTimetableVOList as Array<Record<string, unknown>>;
    rows.push({
      ...rows[0],
      courseName: "Synthetic Course B",
      instructorName: 42,
    });

    const captured = buildExternalCaptureResult(partialPayload, {
      sourceType: "admin_class",
      sourceId: "SYNTH-ADMIN-001",
    });

    expect(captured.quality).toBe("partial");
    expect(captured.skippedCount).toBe(1);
    expect(captured.courses.map((course) => course.name)).toEqual(["Synthetic Course A"]);
  });

  it("rejects malformed wrappers and target ownership without leaking payload content", () => {
    const missingRows = structuredClone(payload);
    delete missingRows.timetable.classTimetableVOList;
    const invalidDate = structuredClone(payload);
    invalidDate.session.beginDate = "2026-02-30";
    const invalidMaxSection = structuredClone(payload);
    invalidMaxSection.timetable.maxSection = 15;
    const wrongSource = structuredClone(payload);
    wrongSource.sourceType = "room";
    const unsafeTargetName = structuredClone(payload);
    unsafeTargetName.target.name = "Synthetic\nAdmin Class";
    const wrongTarget = structuredClone(payload);
    wrongTarget.target.id = "SYNTH-OTHER-ADMIN";
    const wrongOwner = structuredClone(payload);
    const ownedRow = wrongOwner.timetable.classTimetableVOList[0] as Record<string, unknown>;
    ownedRow.adminClassId = "SYNTH-ADMIN-001";
    ownedRow.assignTeachingObject = [{ adminClassId: "SYNTH-OTHER-ADMIN" }];

    const cases: Array<[name: string, value: unknown, code: string]> = [
      ["non-object payload", null, "INVALID_CAPTURE_PAYLOAD"],
      ["wrong contract version", { ...payload, contractVersion: 2 }, "INVALID_CAPTURE_PAYLOAD"],
      ["missing timetable rows", missingRows, "INVALID_CAPTURE_PAYLOAD"],
      ["invalid calendar date", invalidDate, "INVALID_CAPTURE_PAYLOAD"],
      ["max section above the slot bound", invalidMaxSection, "INVALID_CAPTURE_PAYLOAD"],
      ["payload source mismatch", wrongSource, "INVALID_CAPTURE_PAYLOAD"],
      ["unsafe target name", unsafeTargetName, "INVALID_CAPTURE_PAYLOAD"],
      ["wrong selected target", wrongTarget, "TARGET_MISMATCH"],
      ["top-level ownership cannot replace nested ownership", wrongOwner, "TARGET_MISMATCH"],
    ];

    for (const [name, value, code] of cases) {
      const error = captureError(value);
      expect(error, name).toBeInstanceOf(ExternalCaptureError);
      expect(error.code, name).toBe(code);
      expect(error.message, name).not.toContain("SYNTH");
      expect(error.message, name).not.toContain("secretField");
    }

    expect(captureError(payload, { sourceType: "room", sourceId: "SYNTH-ADMIN-001" }).code)
      .toBe("UNSUPPORTED_SOURCE_TYPE");
  });

  it("keeps legal empty distinct from an all-skipped partial capture", () => {
    const emptyPayload = structuredClone(payload);
    emptyPayload.timetable.classTimetableVOList = [];
    const empty = buildExternalCaptureResult(emptyPayload, {
      sourceType: "admin_class",
      sourceId: "SYNTH-ADMIN-001",
    });

    expect(empty.quality).toBe("empty");
    expect(empty.skippedCount).toBe(0);
    expect(empty.courses).toEqual([]);
    expect(empty.result.icsContent).toBe(EMPTY_ICS);

    const allSkippedPayload = structuredClone(payload);
    allSkippedPayload.timetable.classTimetableVOList[0].courseName = "";
    const allSkipped = buildExternalCaptureResult(allSkippedPayload, {
      sourceType: "admin_class",
      sourceId: "SYNTH-ADMIN-001",
    });

    expect(allSkipped.quality).toBe("partial");
    expect(allSkipped.skippedCount).toBe(1);
    expect(allSkipped.courses).toEqual([]);
    expect(allSkipped.result.icsContent).toBe(EMPTY_ICS);
  });

  it("skips owned rows with unverifiable course time or bitmap content", () => {
    const invalidRows: unknown[] = [
      { courseName: "" },
      { weekDay: 0 },
      { teachingWeek: "2" },
      { period: "000" },
      { period: "1".repeat(15) },
      { teachingWeek: "1".repeat(65) },
    ];

    for (const invalidRow of invalidRows) {
      const invalidPayload = structuredClone(payload);
      invalidPayload.timetable.classTimetableVOList[0] = {
        ...invalidPayload.timetable.classTimetableVOList[0],
        ...invalidRow,
      };
      const captured = buildExternalCaptureResult(invalidPayload, {
        sourceType: "admin_class",
        sourceId: "SYNTH-ADMIN-001",
      });

      expect(captured.quality).toBe("partial");
      expect(captured.skippedCount).toBe(1);
      expect(captured.courses).toEqual([]);
    }
  });

  it("skips an owned row whose active period exceeds the captured maxSection", () => {
    const boundedPayload = structuredClone(payload);
    const rows = boundedPayload.timetable.classTimetableVOList;
    rows.push({
      ...structuredClone(rows[0]),
      courseName: "Synthetic Course Beyond Bound",
      period: "0".repeat(13) + "1",
    });

    const captured = buildExternalCaptureResult(boundedPayload, {
      sourceType: "admin_class",
      sourceId: "SYNTH-ADMIN-001",
    });

    expect(captured.quality).toBe("partial");
    expect(captured.skippedCount).toBe(1);
    expect(captured.courses.map((course) => course.name)).toEqual(["Synthetic Course A"]);
  });

  it("splits noncontiguous periods, preserves experiments, and deduplicates exact rows", () => {
    const splitPayload = structuredClone(payload);
    const row = splitPayload.timetable.classTimetableVOList[0];
    row.teachingWeek = "101";
    row.period = "110011";
    row.exprProjectName = "Synthetic Experiment Project";
    splitPayload.timetable.classTimetableVOList.push(structuredClone(row));

    const captured = buildExternalCaptureResult(splitPayload, {
      sourceType: "admin_class",
      sourceId: "SYNTH-ADMIN-001",
    });

    expect(captured.quality).toBe("complete");
    expect(captured.skippedCount).toBe(0);
    expect(captured.courses).toEqual([
      {
        name: "Synthetic Course A",
        lecturer: "Synthetic Instructor A",
        room: "SYNTH-ROOM-001",
        position: "Synthetic Position",
        day_of_week: 1,
        start_session: 1,
        end_session: 2,
        weeks: [1, 3],
        experiment_name: "Synthetic Experiment Project",
      },
      {
        name: "Synthetic Course A",
        lecturer: "Synthetic Instructor A",
        room: "SYNTH-ROOM-001",
        position: "Synthetic Position",
        day_of_week: 1,
        start_session: 5,
        end_session: 6,
        weeks: [1, 3],
        experiment_name: "Synthetic Experiment Project",
      },
    ]);
  });

  it("keeps distinct UID identities for same-name concurrent courses with different content", () => {
    const concurrentPayload = structuredClone(payload);
    const rows = concurrentPayload.timetable.classTimetableVOList;
    rows.push({
      ...structuredClone(rows[0]),
      roomName: "SYNTH-ROOM-002",
      exprProjectName: "Synthetic Experiment Project",
    });

    const captured = buildExternalCaptureResult(concurrentPayload, {
      sourceType: "admin_class",
      sourceId: "SYNTH-ADMIN-001",
    });
    const uids = [...captured.result.icsContent.matchAll(/^UID:(.+)$/gm)]
      .map((match) => match[1]);

    expect(captured.courses).toHaveLength(2);
    expect((captured.result.icsContent.match(/BEGIN:VEVENT/g) ?? []).length).toBe(6);
    expect(uids).toHaveLength(6);
    expect(new Set(uids).size).toBe(6);
  });

  it("fails closed when the capture carries unsupported nonclass arrays", () => {
    const timetableArrayPayload = structuredClone(payload);
    timetableArrayPayload.timetable.examTimetableVOList = [];
    const topLevelArrayPayload: Record<string, unknown> = {
      ...structuredClone(payload),
      examTimetableVOList: [],
    };

    for (const [name, value] of [
      ["timetable array", timetableArrayPayload],
      ["top-level array", topLevelArrayPayload],
    ] as const) {
      expect(captureError(value).code, name).toBe("INVALID_CAPTURE_PAYLOAD");
    }
  });
});
