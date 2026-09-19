import Image from "next/image";

import { isAllowedAvatar } from "@/lib/avatar-hosts";

/**
 * The picture GitHub or Google has of you, beside your name.
 *
 * Through `next/image` rather than a plain `<img>`, and the reason is privacy
 * rather than performance. A bare `<img src="https://lh3.googleusercontent...">`
 * makes every reader's browser call Google on every page of this app, handing
 * over an IP address and a referer on each one. The optimiser fetches it from
 * our server instead, once, and serves it from our origin.
 *
 * `alt=""` on purpose. The name is right next to it in text; a screen reader
 * that also reads "프로필 사진" or the file name says the same thing twice.
 *
 * No picture, or one from a host we do not allow, falls back to the first
 * letter of the name. Not a generic silhouette: an initial tells two accounts
 * apart, which is the only job this element has.
 */
export function UserAvatar({
  image,
  name,
}: {
  image: string | null | undefined;
  name: string;
}) {
  if (isAllowedAvatar(image)) {
    return (
      <Image
        src={image as string}
        alt=""
        width={26}
        height={26}
        // Explicitly sized in CSS as well: an avatar that is briefly the wrong
        // size shifts the whole header row, and this row sits above a canvas
        // that measures itself from its container.
        className="h-[26px] w-[26px] shrink-0 rounded-full border border-edge object-cover"
        // The provider does not need to know which page of ours someone is on.
        referrerPolicy="no-referrer"
      />
    );
  }

  // `[...name]` rather than `name[0]`: a name can begin with an emoji or any
  // character outside the basic plane, and indexing a string by 0 cuts those
  // in half.
  const initial = [...name.trim()][0] ?? "?";

  return (
    <span
      aria-hidden="true"
      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border border-edge bg-ink-raised text-[12px] font-semibold text-said-soft"
    >
      {initial.toUpperCase()}
    </span>
  );
}
