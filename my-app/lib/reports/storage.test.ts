import { afterEach, expect, it, vi } from "vitest";
import { photoStorage } from "./storage";

afterEach(() => { vi.unstubAllEnvs(); });

it("signs only an exact staging key, JPEG content type and bounded upload size", async () => {
  vi.stubEnv("REPORTS_S3_BUCKET", "test-private-bucket");
  vi.stubEnv("REPORTS_S3_ENDPOINT", "https://storage.example");
  vi.stubEnv("REPORTS_S3_REGION", "us-east-1");
  vi.stubEnv("REPORTS_S3_ACCESS_KEY_ID", "test-only-access");
  vi.stubEnv("REPORTS_S3_SECRET_ACCESS_KEY", "test-only-secret");
  const key = "reports/staging/test-photo.jpg";
  const { fields } = await photoStorage.signUpload(key);
  const policy = JSON.parse(Buffer.from(fields.Policy, "base64").toString("utf8"));
  expect(fields.key).toBe(key);
  expect(fields["Content-Type"]).toBe("image/jpeg");
  expect(policy.conditions).toContainEqual(["content-length-range", 1, 1_500_000]);
  expect(policy.conditions).toContainEqual(["eq", "$Content-Type", "image/jpeg"]);
  expect(policy.conditions).toContainEqual({ key });
  expect(new Date(policy.expiration).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
  expect(new Date(policy.expiration).getTime() - Date.now()).toBeGreaterThan(290_000);
});
