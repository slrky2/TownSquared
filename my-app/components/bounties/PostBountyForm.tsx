"use client";

import Image from "next/image";
import { useAuth } from "@clerk/nextjs";
import { uploadBountyPhoto } from "@/lib/reports/upload";
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { APP_CONFIG } from "@/config/app";
import { distanceKm, type LatLng } from "@/lib/maps";
import { formatDollars } from "@/lib/utils";

const CITY_NAME = APP_CONFIG.defaultCity.split(",")[0];
const MAX_PHOTO_INPUT_BYTES = 15 * 1024 * 1024; // before shrinking

export interface PostBountyValues {
  title: string;
  details: string;
  reward: number;
  place: string;
  lat: number | null;
  lng: number | null;
  /** Owned, validated photo uploaded directly to storage. */
  photoId: string | null;
  asCity: boolean;
}

interface Props {
  wallet: number;
  isCityStaff: boolean;
  onClose: () => void;
  /** Should throw with a readable message on failure. */
  onSubmit: (values: PostBountyValues) => Promise<void>;
}

type PinState =
  | { status: "none" }
  | { status: "locating" }
  | { status: "pinned"; coords: LatLng }
  | { status: "error"; message: string };

/** Dialog for posting a job, with an optional map pin at the poster's location. */
export default function PostBountyForm({ wallet, isCityStaff, onClose, onSubmit }: Props) {
  const uid = useId();
  const { userId } = useAuth();
  const uploaded = useRef<{ file: File; userId: string; photoId: string; at: number } | null>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [reward, setReward] = useState("20");
  const [place, setPlace] = useState("");
  const [asCity, setAsCity] = useState(false);
  const [pin, setPin] = useState<PinState>({ status: "none" });
  const [photo, setPhoto] = useState<{ file: File; previewUrl: string } | null>(null);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.previewUrl); }, [photo]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape, like other dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function pinMyLocation() {
    if (!("geolocation" in navigator)) {
      setPin({ status: "error", message: "Your browser can't share its location." });
      return;
    }
    setPin({ status: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (distanceKm(coords, APP_CONFIG.defaultMapCenter) > APP_CONFIG.localAreaRadiusKm) {
          setPin({ status: "error", message: `You're outside ${CITY_NAME}, so the job can't be pinned here.` });
        } else {
          setPin({ status: "pinned", coords });
        }
      },
      () => setPin({ status: "error", message: "Couldn't get your location. Check the browser permission." }),
      { timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  function pickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    setPhotoError(null);
    uploaded.current = null;
    if (!file.type.startsWith("image/") || file.size > MAX_PHOTO_INPUT_BYTES) {
      setPhoto(null);
      setPhotoError("Choose an image under 15 MB.");
    } else {
      setPhoto({ file, previewUrl: URL.createObjectURL(file) });
    }
    e.currentTarget.value = "";
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!userId) throw new Error("Sign in to post a job.");
      let photoId: string | null = null;
      if (photo) {
        if (!uploaded.current || uploaded.current.file !== photo.file || uploaded.current.userId !== userId || Date.now() - uploaded.current.at > 50 * 60_000) {
          uploaded.current = { file: photo.file, userId, photoId: await uploadBountyPhoto(photo.file), at: Date.now() };
        }
        photoId = uploaded.current.photoId;
      }
      const coords = pin.status === "pinned" ? pin.coords : null;
      await onSubmit({
        title,
        details,
        reward: Number(reward),
        place,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        photoId,
        asCity,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't post the job.");
      setSubmitting(false);
    }
  }

  const field =
    "mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-white/15 dark:bg-zinc-950";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:max-w-md sm:rounded-2xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id={`${uid}-title`} className="text-lg font-bold">
            Post a job
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-600">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor={`${uid}-t`} className="text-sm font-medium">
              What needs doing?
            </label>
            <input
              id={`${uid}-t`}
              autoFocus
              required
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Mow my lawn"
              aria-describedby={`${uid}-t-hint`}
              className={field}
            />
            <p id={`${uid}-t-hint`} className="mt-1 text-xs text-zinc-500">
              Chores and small favors. Road, streetlight or utility repairs are city crew jobs.
            </p>
          </div>

          <div>
            <label htmlFor={`${uid}-d`} className="text-sm font-medium">
              Details
            </label>
            <textarea
              id={`${uid}-d`}
              rows={3}
              maxLength={2000}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="When, how long, what to bring"
              className={field}
            />
          </div>

          <div className="flex gap-3">
            <div className="w-28">
              <label htmlFor={`${uid}-r`} className="text-sm font-medium">
                Reward ($)
              </label>
              <input
                id={`${uid}-r`}
                type="number"
                required
                min={0.01}
                max={1000}
                step="0.01"
                value={reward}
                onChange={(e) => setReward(e.target.value)}
                className={field}
              />
            </div>
            <div className="flex-1">
              <label htmlFor={`${uid}-p`} className="text-sm font-medium">
                Where
              </label>
              <input
                id={`${uid}-p`}
                required
                maxLength={120}
                value={place}
                onChange={(e) => setPlace(e.target.value)}
                placeholder="Pawtucket St"
                aria-describedby={`${uid}-p-hint`}
                className={field}
              />
            </div>
          </div>
          <p id={`${uid}-p-hint`} className="-mt-1 text-xs text-zinc-500">
            Street or neighborhood. Workers tap it for directions.
          </p>

          <div>
            <label htmlFor={`${uid}-img`} className="text-sm font-medium">
              Photo (optional)
            </label>
            {photo ? (
              <div className="mt-1 space-y-1">
                <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
                  <Image src={photo.previewUrl} alt="Preview of your job photo" fill unoptimized className="object-cover" />
                </div>
                <button
                  type="button"
                  onClick={() => setPhoto(null)}
                  className="text-xs text-zinc-500 underline hover:text-zinc-700"
                >
                  Remove photo
                </button>
              </div>
            ) : (
              <input
                id={`${uid}-img`}
                type="file"
                accept="image/*"
                onChange={pickPhoto}
                disabled={submitting}
                aria-describedby={`${uid}-img-hint`}
                className="mt-1 block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-50 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-emerald-700 hover:file:bg-emerald-100 dark:text-zinc-300 dark:file:bg-emerald-500/15 dark:file:text-emerald-300"
              />
            )}
            <p id={`${uid}-img-hint`} className="mt-1 text-xs text-zinc-500">
              {submitting ? "Uploading photo…" : "Show the yard, the couch, the job. Location data is removed."}
            </p>
            {photoError && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {photoError}
              </p>
            )}
          </div>

          <div className="text-sm">
            {pin.status === "pinned" ? (
              <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                📍 Pinned at your current location
                <button
                  type="button"
                  onClick={() => setPin({ status: "none" })}
                  className="text-xs text-zinc-500 underline"
                >
                  Remove
                </button>
              </p>
            ) : (
              <button
                type="button"
                onClick={pinMyLocation}
                disabled={pin.status === "locating"}
                className="font-medium text-emerald-700 hover:underline disabled:opacity-50 dark:text-emerald-400"
              >
                {pin.status === "locating" ? "Finding you…" : "📍 Pin it on the map at my location"}
              </button>
            )}
            {pin.status === "error" && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{pin.message}</p>}
          </div>

          {isCityStaff && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={asCity} onChange={(e) => setAsCity(e.target.checked)} />
              Post as {CITY_NAME} (paid by the city)
            </label>
          )}

          <p className="text-xs text-zinc-500">
            {asCity
              ? "City jobs don't use your wallet. City staff approve the payout."
              : `The reward is held from your wallet (${formatDollars(wallet)}) now and paid to the worker when you approve.`}
          </p>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-emerald-600 py-2.5 font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Posting…" : "Post job"}
          </button>
        </form>
      </div>
    </div>
  );
}
