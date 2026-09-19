"use client";

import { useState } from "react";

import { ProviderMark } from "@/components/auth/provider-mark";
import { signIn } from "@/lib/auth-client";

type Provider = "github" | "google";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "github", label: "GitHub으로 계속하기" },
  { id: "google", label: "Google로 계속하기" },
];

export function SignInButtons() {
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn(provider: Provider) {
    setPending(provider);
    setError(null);
    try {
      await signIn.social({ provider, callbackURL: "/app" });
    } catch {
      // Plain language, and it says what to do next (section 8). The technical
      // detail belongs in logs, not on the user's screen.
      setError("로그인을 시작하지 못했습니다. 잠시 후 다시 눌러보세요.");
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {PROVIDERS.map((provider) => (
        <button
          key={provider.id}
          type="button"
          onClick={() => handleSignIn(provider.id)}
          disabled={pending !== null}
          className="relative flex w-full items-center justify-center rounded-xl border border-edge bg-ink-raised px-5 py-3.5 text-[15px] font-medium transition-colors hover:border-edge-lit hover:bg-ink disabled:opacity-55"
        >
          {/*
            Absolute, so the label stays on the button's centre line and the two
            buttons' text lines up with each other. Laid out in the flow it
            would push each label sideways by the width of its own mark, and
            "GitHub으로 계속하기" and "Google로 계속하기" would sit at two
            different offsets — a misalignment you cannot unsee once noticed.

            The mark stays put while the label changes to "이동하는 중…", so the
            button does not appear to change identity at the moment it is
            pressed.
          */}
          <span className="absolute left-5 flex items-center text-paper">
            <ProviderMark provider={provider.id} />
          </span>
          {pending === provider.id ? "이동하는 중…" : provider.label}
        </button>
      ))}

      {error ? (
        <p role="alert" className="mt-1 text-[14px] text-c4">
          {error}
        </p>
      ) : null}
    </div>
  );
}
