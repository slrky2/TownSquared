"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import type { CityPost } from "@/types";

const fetchPosts = ([url]: readonly [string, string]) => api.get<{ posts: CityPost[] }>(url).then((res) => res.posts);

export function usePosts() {
  const { userId, isLoaded } = useAuth();
  const key = isLoaded ? ["/api/posts", userId ?? "public"] as const : null;
  const { data, error, mutate } = useSWR(key, fetchPosts, { refreshInterval: 15_000 });
  const posts = data ?? [];

  async function toggleReaction(postId: number) {
    if (!userId) throw new Error("Sign in to thank your neighbors.");
    await mutate(async (current) => {
      const { post } = await api.post<{ post: CityPost }>(`/api/posts/${postId}/react`, {});
      return (current ?? []).map((p) => p.id === post.id ? post : p);
    }, {
      optimisticData: (current) => (current ?? []).map((p) => p.id === postId
        ? { ...p, hasReacted: !p.hasReacted, reactions: p.reactions + (p.hasReacted ? -1 : 1) } : p),
      rollbackOnError: true, revalidate: false,
    });
  }

  return { posts, error, isLive: data !== undefined, toggleReaction };
}
