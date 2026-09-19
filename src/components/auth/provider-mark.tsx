/**
 * The GitHub and Google marks, in one colour.
 *
 * Both are drawn with `fill="currentColor"`, so they take the colour of the
 * text beside them and change with it — on a disabled button, on hover, in a
 * future light theme. A mark that needs its own colour value is a mark that
 * will eventually be the wrong one.
 *
 * Inline SVG rather than files: two icons is less markup than two network
 * requests, and an `<img>` here would flash in after the button it belongs to.
 *
 * `aria-hidden`, always. The button already says "GitHub으로 계속하기"; a screen
 * reader that also announces the logo reads the provider's name twice, which is
 * how a decoration turns into noise. The mark is for people who recognise the
 * shape faster than they read the word.
 *
 * Google's own brand guidance asks for the four-colour G on a light surface or
 * its white-on-blue lockup. This is the monochrome mark on a dark surface — a
 * deliberate choice to keep one visual language across both buttons, since a
 * single coloured logo in a two-colour interface reads as an advertisement
 * sitting inside the product.
 */

const SIZE = "h-[18px] w-[18px] shrink-0";

export function GithubMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={`${SIZE} ${className}`}
      fill="currentColor"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export function GoogleMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={`${SIZE} ${className}`}
      fill="currentColor"
    >
      <path d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z" />
    </svg>
  );
}

/** One place that knows which mark goes with which provider name. */
export function ProviderMark({ provider }: { provider: "github" | "google" }) {
  return provider === "github" ? <GithubMark /> : <GoogleMark />;
}
