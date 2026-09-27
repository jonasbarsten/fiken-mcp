import { beforeEach, vi } from "vitest";

// The app writes one JSON log line per request. Swallow it so test output
// stays clean; tests that assert on logs re-spy process.stdout.write.
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
