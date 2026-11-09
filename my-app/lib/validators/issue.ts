import { z } from "zod";
import { REPORT_CATEGORIES, REPORT_LIMITS } from "@/lib/utils/report";

export const createIssueSchema = z.object({
  title: z.string().min(5, "Title must be at least 5 characters").max(120),
  description: z.string().min(10, "Please provide more detail").max(2000),
  category: z.enum([
    "road_hazard",
    "road_blockage",
    "pothole",
    "broken_streetlight",
    "graffiti",
    "flooding",
    "fallen_tree",
    "abandoned_vehicle",
    "noise_complaint",
    "other",
  ]),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().optional(),
  imageUrls: z.array(z.string().url()).max(5).optional(),
});

export type CreateIssueInput = z.infer<typeof createIssueSchema>;

/** Session identity is never accepted from request bodies. */
export const commentSchema = z.strictObject({
  text: z.string().trim().min(1, "Comment can't be empty").max(500, "Keep comments under 500 characters"),
});

export const createReportSchema = z.strictObject({
  description: z.string().trim()
    .min(REPORT_LIMITS.minDescription, `Please describe the issue in at least ${REPORT_LIMITS.minDescription} characters`)
    .max(REPORT_LIMITS.maxDescription),
  category: z.enum(REPORT_CATEGORIES),
  severity: z.enum(["High", "Medium", "Low"]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  locationDetails: z.string().trim().max(REPORT_LIMITS.maxLocationDetails).optional(),
  photoIds: z.array(z.uuid()).max(REPORT_LIMITS.maxPhotos).default([])
    .refine((ids) => new Set(ids).size === ids.length, "Each photo may only be attached once"),
});

export type CreateReportInput = z.input<typeof createReportSchema>;
export type NewReport = z.output<typeof createReportSchema>;
