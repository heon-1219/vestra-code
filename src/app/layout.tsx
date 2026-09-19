import type { Metadata, Viewport } from "next";

import "./globals.css";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Vestra Code — 내 프로젝트의 지도",
  description:
    "AI로 만든 프로젝트가 손을 떠나기 전에. GitHub 저장소를 연결하면 앱의 지도를 그려주고, 무엇이 무엇과 연결돼 있는지 사람의 말로 알려줍니다.",
  applicationName: "Vestra Code",
};

export const viewport: Viewport = {
  themeColor: "#0d0c0a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <head>
        {/*
          Pretendard, loaded as a dynamic subset: Korean has thousands of
          glyphs, and the dynamic-subset build splits the face into many small
          woff2 files so a page downloads only the syllables it actually uses.
          Loading the whole face would be megabytes.

          preconnect first so the font request does not wait on a fresh TLS
          handshake, and `display=swap` is built into the stylesheet so the
          headline renders in a fallback immediately rather than blocking —
          the brief requires the headline to be real text that appears before
          the canvas.
        */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="min-h-full bg-ink text-said flex flex-col">
        {children}
        {/*
          `mt-auto` on the footer plus this flex column is what keeps it at the
          bottom of a short page without pinning it over a long one — the
          sign-in page is half a screen tall and a footer sitting in the middle
          of it reads as the page having failed to load the rest.
        */}
        <SiteFooter />
      </body>
    </html>
  );
}
