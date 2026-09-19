/**
 * Where a profile picture is allowed to come from.
 *
 * Read by two places that must agree: `next.config.ts`, which will refuse to
 * optimise an image from any other host, and the avatar component, which falls
 * back to an initial rather than rendering an `<Image>` that is going to throw.
 * Written once and imported by both, because the failure mode of two copies is
 * a broken header on someone else's account — a provider we allowed in the
 * config and forgot in the component, or the reverse.
 *
 * These are the hosts Better Auth stores for the two providers we offer.
 * GitHub serves avatars from `avatars.githubusercontent.com`; Google uses
 * several numbered `googleusercontent.com` subdomains, of which `lh3` is the
 * one it hands out today, so that domain is matched by wildcard.
 */
export const AVATAR_HOSTS = [
  "avatars.githubusercontent.com",
  "**.googleusercontent.com",
] as const;

/**
 * Whether we can render this URL through the image optimiser.
 *
 * Deliberately strict: anything that is not an https URL on an allowed host is
 * treated as no picture at all. A profile image URL arrives from an identity
 * provider and is stored as given, so this is the boundary where it stops being
 * "some string the database had" and becomes something we will fetch.
 */
export function isAllowedAvatar(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return AVATAR_HOSTS.some((pattern) =>
    pattern.startsWith("**.")
      ? parsed.hostname.endsWith(pattern.slice(2))
      : parsed.hostname === pattern,
  );
}
