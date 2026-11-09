import db, { type Database } from "@/lib/db";
import { createPhotoUploads } from "@/lib/photos/uploads";
import { photoStorage, type PhotoStorage } from "./storage";

export const reportPhotos = (database: Database, storage: PhotoStorage) => createPhotoUploads(database, storage, "reports");
export const { begin: beginPhotoUpload, complete: completePhotoUpload } = reportPhotos(db, photoStorage);
