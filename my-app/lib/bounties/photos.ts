import db from "@/lib/db";
import { createPhotoUploads } from "@/lib/photos/uploads";
import { photoStorage } from "@/lib/reports/storage";

export const { begin: beginBountyPhotoUpload, complete: completeBountyPhotoUpload } = createPhotoUploads(db, photoStorage, "bounties");
