import { z } from "zod";

/**
 * Body for POST /api/bounties. Who is posting comes from the Clerk session,
 * never from the body.
 */
export const createBountySchema = z
  .strictObject({
    title: z.string().trim().min(1, "Give the job a title.").max(120, "Keep the title under 120 characters."),
    details: z.string().trim().max(2000, "Keep the details under 2,000 characters.").default(""),
    reward: z
      .number({ error: "Reward must be a number." })
      .gt(0, "The reward must be more than $0.")
      .max(1000, "The reward can be at most $1,000.")
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, "Use whole cents for the reward."),
    place: z
      .string({ error: "Say where the job is, like a street or neighborhood." })
      .trim()
      .min(1, "Say where the job is, like a street or neighborhood.")
      .max(120, "Keep the place under 120 characters."),
    lat: z.number().min(-90).max(90).nullable().default(null),
    lng: z.number().min(-180).max(180).nullable().default(null),
    /** Ready photo uploaded directly to storage by the signed-in account. */
    photoId: z.uuid().nullable().default(null),
    /** Post as the city (city staff only). */
    asCity: z.boolean().default(false),
  })
  .refine((b) => (b.lat === null) === (b.lng === null), {
    message: "Send both lat and lng, or neither.",
  });

export type CreateBountyInput = z.infer<typeof createBountySchema>;

/** The step in POST /api/bounties/:bountyId/:action. */
export const bountyActionSchema = z.enum(["claim", "done", "approve"]);
