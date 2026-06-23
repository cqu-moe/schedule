import { decodeStudentIdFromBearer } from "./cqu-api";

/**
 * Resolve the CQU 学号 (student ID) of the authenticated user from a CQU OAuth
 * JWT bearer's `user_name` claim ({@link decodeStudentIdFromBearer}) — NEVER from
 * any client-supplied input.
 *
 * Retained after the bearer-acquisition layer was retired (organic harvest): any
 * caller that still has a bearer JWT (e.g. external search) can derive the own
 * 学号 tamper-proof. Returns `null` (never throws) when the token carries no
 * usable student ID. The bearer is sensitive and is NEVER logged; `userId` is for
 * log correlation only.
 */
export function resolveOwnStudentId(bearer: string, userId: string): string | null {
  const studentId = decodeStudentIdFromBearer(bearer);
  if (!studentId) {
    console.log(
      JSON.stringify({
        event: "cqu_bearer.student_id.unresolved",
        userId,
        message: "Bearer carries no student ID; skipping user",
      }),
    );
    return null;
  }
  return studentId;
}
