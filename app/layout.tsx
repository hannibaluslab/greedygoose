import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "GreedyGoose",
  description: "USDC credit backed by your tokenized stocks, without selling them.",
};

// viewportFit cover: the canvas is drawn edge to edge, so the page runs under the status bar and
// home indicator, and fixed bars and sheets pad themselves with env(safe-area-inset-*).
export const viewport: Viewport = { themeColor: "#f4f2ec", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
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
