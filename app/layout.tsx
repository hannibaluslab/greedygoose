import type { Metadata, Viewport } from "next";
import { THEME_BOOT } from "@/lib/theme";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// The link preview (WhatsApp, iMessage, X…): app/opengraph-image.jpg and twitter-image.jpg, 1200x630, made absolute by
// metadataBase. A preview deploy's own address comes from Vercel; production is app.greedygoo.com (Adrian, 2026-10-21:
// with greedygoose.vercel.app here, a link to app.greedygoo.com pointed its card and image at another domain, and chat
// apps showed no thumbnail).
const SITE =
  process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://app.greedygoo.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "GreedyGoo",
  description: "Let your money get greedy. Cash, stocks and credit in one account.",
  openGraph: {
    type: "website",
    url: "/",
    siteName: "GreedyGoo",
    title: "GreedyGoo",
    description: "Let your money get greedy. Cash, stocks and credit in one account.",
  },
  twitter: {
    card: "summary_large_image",
    title: "GreedyGoo",
    description: "Let your money get greedy. Cash, stocks and credit in one account.",
  },
};

// viewportFit cover: the canvas is drawn edge to edge, so the page runs under the status bar and
// home indicator, and fixed bars and sheets pad themselves with env(safe-area-inset-*). The boards' 54px top
// included the status bar, so a screen's top is the inset plus the 8px left under it (0 in a Safari tab, where
// the page starts below the bar; the bar's height once added to the Home Screen).
export const viewport: Viewport = {
  themeColor: "#f4f2ec",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: THEME_BOOT sets data-theme on <html> before React hydrates it.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        {/* Light or dark before the first paint (lib/theme.ts), so a dark page never flashes light. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        {/* Runs during parse, before the browser restores scroll (an effect would be too late).
            Safari restores the previous scroll offset on reload, and with that offset an open sheet
            (useBodyScrollLock pins body at top: -offset) keeps a hit-test region that is stale by
            the offset until the first scroll or touch: taps inside the sheet land offset px away
            from what they aim at. Starting at the top removes the offset. Trade-off: back/forward
            no longer restores scroll natively (the App Router does it for client navigations). */}
        <script dangerouslySetInnerHTML={{ __html: 'try{history.scrollRestoration="manual"}catch(e){}' }} />
        <Providers>
          <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
