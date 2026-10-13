import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "GreedyGoose",
  description: "Borrow USDC against your tokenized stocks without selling them.",
};

export const viewport: Viewport = { themeColor: "#f4f2ec", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Providers>
          <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
