import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  actor: vi.fn(), auth: vi.fn(), postBounty: vi.fn(), takeStep: vi.fn(),
  listBounties: vi.fn(), getViewer: vi.fn(), getImageKey: vi.fn(), read: vi.fn(),
  beginBountyPhotoUpload: vi.fn(), completeBountyPhotoUpload: vi.fn(),
}));
vi.mock("@/lib/bounties/actor", () => ({ getActor: mocks.actor }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/bounties/store", () => mocks);
vi.mock("@/lib/bounties/photos", () => mocks);
vi.mock("@/lib/reports/storage", () => ({ photoStorage: { read: mocks.read } }));
import { GET, POST } from "./route";
import { POST as step } from "./[bountyId]/[action]/route";
import { POST as upload } from "./photos/upload/route";
import { POST as complete } from "./photos/[photoId]/complete/route";
import { GET as image } from "../bounty-images/[imageId]/route";
import { RequestError } from "@/lib/api/errors";

const actor = { id: "user_session", name: "Alice", isCityStaff: false };
const data = { title: "Rake leaves", reward: 20, place: "Lowell" };
const request = (body: unknown) => new Request("http://localhost/api/bounties", { method: "POST", body: JSON.stringify(body) });
const context = { params: Promise.resolve({ bountyId: "12", action: "claim" }) };
const photoId = "12345678-1234-4123-8123-123456789012";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue(actor);
  mocks.auth.mockResolvedValue({ userId: actor.id });
  mocks.listBounties.mockResolvedValue([]);
  mocks.getViewer.mockResolvedValue({ name: actor.name, wallet: 35, isCityStaff: false });
  mocks.postBounty.mockResolvedValue({ id: 12 });
});

it("requires authentication for job creation, steps and both photo endpoints", async () => {
  mocks.actor.mockResolvedValue(null);
  mocks.auth.mockResolvedValue({ userId: null });
  const responses = await Promise.all([
    POST(request(data)), step(request({}), context), upload(),
    complete(request({}), { params: Promise.resolve({ photoId }) }),
  ]);
  expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401]);
  for (const fn of [mocks.postBounty, mocks.takeStep, mocks.beginBountyPhotoUpload, mocks.completeBountyPhotoUpload]) expect(fn).not.toHaveBeenCalled();
});

it("awaits persistence and derives job ownership exclusively from the session", async () => {
  expect((await POST(request(data))).status).toBe(201);
  expect(mocks.postBounty).toHaveBeenCalledWith(actor, { ...data, details: "", lat: null, lng: null, photoId: null, asCity: false });
  await step(request({ actorId: "forged" }), context);
  expect(mocks.takeStep).toHaveBeenCalledWith(actor, 12, "claim");
  expect((await POST(request({ ...data, posterId: "forged" }))).status).toBe(422);
  expect((await POST(request({ ...data, image: "data:image/jpeg;base64,AAAA" }))).status).toBe(422);
});

it("keeps public reads available without sharing account-specific cache entries", async () => {
  mocks.actor.mockResolvedValue(null);
  const response = await GET();
  expect(await response.json()).toEqual({ bounties: [], viewer: null });
  expect(mocks.getViewer).not.toHaveBeenCalled();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("bounds request bodies and returns business conflicts without exposing internal errors", async () => {
  expect((await POST(request({ ...data, details: "x".repeat(20000) }))).status).toBe(413);
  mocks.takeStep.mockRejectedValue(new RequestError(409, "Someone already claimed this job."));
  expect((await step(request({}), context)).status).toBe(409);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    mocks.listBounties.mockRejectedValue(new Error("private connection details"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private connection details");
  } finally { logged.mockRestore(); }
});

it("returns 404 for draft/missing photos and only serves published object keys", async () => {
  const ctx = { params: Promise.resolve({ imageId: photoId }) };
  mocks.getImageKey.mockResolvedValue(null);
  expect((await image(request({}), ctx)).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.getImageKey.mockResolvedValue("bounties/photos/example.jpg");
  mocks.read.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
  const response = await image(request({}), ctx);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(mocks.read).toHaveBeenCalledWith("bounties/photos/example.jpg");
});
