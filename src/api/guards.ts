/** Canonical plain-object guard for narrowing untrusted request and persisted JSON input. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
