"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR, { mutate as globalMutate } from "swr";
import { api } from "@/lib/api/client";
import type { CreateReportInput } from "@/lib/validators/issue";
import type { CityPost, CityReport } from "@/types";

const fetchReports = ([url]: readonly [string, string]) =>
  api.get<{ reports: CityReport[] }>(url).then((res) => res.reports);
const replaceReport = (reports: CityReport[], updated: CityReport) =>
  reports.map((r) => r.id === updated.id ? updated : r);

export function useIssues() {
  const { userId, isLoaded } = useAuth();
  // The cache is partitioned by account; identity itself is read only from the session on the server.
  const key = isLoaded ? ["/api/issues", userId ?? "public"] as const : null;
  const { data, error, mutate } = useSWR(key, fetchReports, { refreshInterval: 15_000 });
  const reports = data ?? [];

  function requireSignIn() {
    if (!userId) throw new Error("Sign in to report, comment, or vote.");
  }

  async function toggleUpvote(issueId: number) {
    requireSignIn();
    await mutate(async (current) => {
      const { report } = await api.post<{ report: CityReport }>(`/api/issues/${issueId}/upvote`, {});
      return replaceReport(current ?? [], report);
    }, {
      optimisticData: (current) => (current ?? []).map((r) => r.id === issueId
        ? { ...r, hasUpvoted: !r.hasUpvoted, upvotes: r.upvotes + (r.hasUpvoted ? -1 : 1) } : r),
      rollbackOnError: true, revalidate: false,
    });
  }

  async function addComment(issueId: number, text: string) {
    requireSignIn();
    const { report } = await api.post<{ report: CityReport }>(`/api/issues/${issueId}/comments`, { text });
    await mutate((current) => replaceReport(current ?? [], report), { revalidate: false });
  }

  async function createReport(input: CreateReportInput): Promise<CityReport> {
    requireSignIn();
    const { report, post } = await api.post<{ report: CityReport; post: CityPost }>("/api/issues", input);
    await mutate((current) => [report, ...(current ?? []).filter((r) => r.id !== report.id)], { revalidate: false });
    await globalMutate<CityPost[]>(
      (key) => Array.isArray(key) && key[0] === "/api/posts" && key[1] === userId,
      (current) => current ? [post, ...current.filter((p) => p.id !== post.id)] : current,
      { revalidate: false },
    );
    return report;
  }

  return { reports, error, isLive: data !== undefined, toggleUpvote, addComment, createReport };
}
