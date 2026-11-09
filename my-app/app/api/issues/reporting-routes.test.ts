import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), createReport: vi.fn(), listReports: vi.fn(), listPosts: vi.fn(),
  addComment: vi.fn(), toggleUpvote: vi.fn(), toggleReaction: vi.fn(), getPhotoKey: vi.fn(),
  beginPhotoUpload: vi.fn(), completePhotoUpload: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db/store", () => mocks);
vi.mock("@/lib/reports/photos", () => mocks);
import { GET as getReports, POST as create } from "./route";
import { GET as getPosts } from "../posts/route";
import { POST as comment } from "./[issueId]/comments/route";
import { POST as vote } from "./[issueId]/upvote/route";
import { POST as react } from "../posts/[postId]/react/route";
import { POST as upload } from "./photos/upload/route";
import { POST as complete } from "./photos/[photoId]/complete/route";

const request = (body: unknown) => new Request("http://localhost/api/issues", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const validReport = {
  description: "Pothole near the crossing", category: "Roads", severity: "High", lat: 42.64, lng: -71.31,
};
const issueContext = { params: Promise.resolve({ issueId: "12" }) };
const postContext = { params: Promise.resolve({ postId: "12" }) };
const photoContext = { params: Promise.resolve({ photoId: "12345678-1234-4123-8123-123456789012" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ userId: "user_session" });
  mocks.createReport.mockResolvedValue({ report: { id: 12 }, post: { id: 12 } });
  mocks.listReports.mockResolvedValue([]);
  mocks.listPosts.mockResolvedValue([]);
});

describe("reporting API authentication boundary", () => {
  it("requires a session for every write before parsing the request or touching storage", async () => {
    mocks.auth.mockResolvedValue({ userId: null });
    const responses = await Promise.all([
      create(request(validReport)), comment(request({ text: "Hello" }), issueContext),
      vote(request({ viewerId: "forged" }), issueContext), react(request({ viewerId: "forged" }), postContext),
      upload(), complete(request({}), photoContext),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
    for (const method of [mocks.createReport, mocks.addComment, mocks.toggleUpvote, mocks.toggleReaction, mocks.beginPhotoUpload, mocks.completePhotoUpload]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("rejects caller identity and inline image data in report/comment bodies", async () => {
    expect((await create(request({ ...validReport, viewerId: "user_other" }))).status).toBe(400);
    expect((await create(request({ ...validReport, photos: ["data:image/jpeg;base64,AAAA"] }))).status).toBe(400);
    expect((await comment(request({ text: "Hello", viewerId: "user_other" }), issueContext)).status).toBe(400);
    expect(mocks.createReport).not.toHaveBeenCalled();
    expect(mocks.addComment).not.toHaveBeenCalled();
  });

  it("uses the session for writes even if vote/reaction callers supply a forged identity", async () => {
    expect((await create(request(validReport))).status).toBe(201);
    expect(mocks.createReport).toHaveBeenCalledWith({ ...validReport, photoIds: [] }, "user_session");
    await comment(request({ text: "A useful comment" }), issueContext);
    expect(mocks.addComment).toHaveBeenCalledWith(12, "user_session", "A useful comment");
    await vote(request({ viewerId: "user_other" }), issueContext);
    expect(mocks.toggleUpvote).toHaveBeenCalledWith(12, "user_session");
    await react(request({ viewerId: "user_other" }), postContext);
    expect(mocks.toggleReaction).toHaveBeenCalledWith(12, "user_session");
  });

  it("keeps public reads available and prevents shared caching of viewer-specific responses", async () => {
    mocks.auth.mockResolvedValue({ userId: null });
    const reportResponse = await getReports();
    const postResponse = await getPosts();
    expect(reportResponse.status).toBe(200);
    expect(postResponse.status).toBe(200);
    expect(mocks.listReports).toHaveBeenCalledWith(null);
    expect(mocks.listPosts).toHaveBeenCalledWith(null);
    expect(reportResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(postResponse.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects malformed and oversized JSON and duplicate photo IDs", async () => {
    const malformed = new Request("http://localhost/api/issues", { method: "POST", body: "{" });
    expect((await create(malformed)).status).toBe(400);
    expect((await create(request({ ...validReport, description: "x".repeat(20_000) }))).status).toBe(413);
    const id = "12345678-1234-4123-8123-123456789012";
    expect((await create(request({ ...validReport, photoIds: [id, id] }))).status).toBe(400);
    expect(mocks.createReport).not.toHaveBeenCalled();
  });

  it("does not expose database connection errors to clients", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.listReports.mockRejectedValue(new Error("postgres://private-password@internal-host/database"));
      const response = await getReports();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-password");
    } finally {
      logged.mockRestore();
    }
  });
});
