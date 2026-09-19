"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { signOut } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    try {
      await signOut();
      router.push("/");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={pending}
      className="text-[14px] text-said-soft transition-colors hover:text-said disabled:opacity-55"
    >
      {pending ? "나가는 중…" : "로그아웃"}
    </button>
  );
}
