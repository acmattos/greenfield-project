const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A malformed id passed straight into a `uuid`-typed column query throws an
// unhandled driver-level error (invalid input syntax for type uuid),
// surfacing as a 500 instead of a controlled response. Validate the shape
// before ever querying.
export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}
