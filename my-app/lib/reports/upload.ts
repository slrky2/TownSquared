import { api } from "@/lib/api/client";
import { photoToJpegBlob } from "@/lib/utils/image";
import { REPORT_LIMITS } from "@/lib/utils/report";

/** Only upload authorization and photo ids go through Next.js; image bytes go to S3. */
export async function uploadPhoto(file: File, resource: "issues" | "bounties"): Promise<string> {
  const jpeg = await photoToJpegBlob(file);
  if (jpeg.size > REPORT_LIMITS.maxPhotoBytes) throw new Error("Photo is too large after resizing. Choose a smaller image.");
  const upload = await api.post<{ photoId: string; url: string; fields: Record<string, string> }>(
    `/api/${resource}/photos/upload`, {},
  );
  const body = new FormData();
  for (const [key, value] of Object.entries(upload.fields)) body.append(key, value);
  body.append("file", jpeg, "photo.jpg");
  const response = await fetch(upload.url, { method: "POST", body, credentials: "omit" });
  if (!response.ok) throw new Error("Photo upload failed. Please try again.");
  await api.post(`/api/${resource}/photos/${upload.photoId}/complete`, {});
  return upload.photoId;
}

export const uploadReportPhoto = (file: File) => uploadPhoto(file, "issues");
export const uploadBountyPhoto = (file: File) => uploadPhoto(file, "bounties");
