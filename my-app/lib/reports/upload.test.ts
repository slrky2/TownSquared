import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ post: vi.fn(), photoToJpegBlob: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ api: { post: mocks.post } }));
vi.mock("@/lib/utils/image", () => ({ photoToJpegBlob: mocks.photoToJpegBlob }));
import { uploadReportPhoto, uploadBountyPhoto } from "./upload";

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("direct report photo uploads", () => {
  it.each([["issues", uploadReportPhoto], ["bounties", uploadBountyPhoto]] as const)("uploads %s photos directly and only sends small JSON requests to the application", async (resource, upload) => {
    const jpeg = new Blob(["jpeg bytes"], { type: "image/jpeg" });
    mocks.photoToJpegBlob.mockResolvedValue(jpeg);
    mocks.post.mockResolvedValueOnce({
      photoId: "photo-id", url: "https://storage.example/bucket",
      fields: { key: "reports/staging/photo-id.jpg", policy: "signed-policy", "Content-Type": "image/jpeg" },
    }).mockResolvedValueOnce({ photoId: "photo-id" });
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    expect(await upload(new File(["input"], "phone.png"))).toBe("photo-id");
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://storage.example/bucket");
    expect(options).toMatchObject({ method: "POST", credentials: "omit" });
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get("key")).toBe("reports/staging/photo-id.jpg");
    expect(await options.body.get("file").text()).toBe("jpeg bytes");
    expect(mocks.post.mock.calls).toEqual([
      [`/api/${resource}/photos/upload`, {}], [`/api/${resource}/photos/photo-id/complete`, {}],
    ]);
  });

  it("does not finalize failed uploads or authorize oversized images", async () => {
    mocks.photoToJpegBlob.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    mocks.post.mockResolvedValue({ photoId: "id", url: "https://storage.example", fields: {} });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(uploadReportPhoto(new File([], "photo.jpg"))).rejects.toThrow("Photo upload failed");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    mocks.post.mockClear();
    mocks.photoToJpegBlob.mockResolvedValue(new Blob([new Uint8Array(1_500_001)]));
    await expect(uploadReportPhoto(new File([], "large.jpg"))).rejects.toThrow("too large");
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
