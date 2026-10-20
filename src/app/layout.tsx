import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ServiceWorker } from "@/components/shell/service-worker";
import { ClientErrorReporter } from "@/components/shell/client-error-reporter";
import { HydrationGate } from "@/components/shell/hydration-gate";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Edapt CRM", template: "%s · Edapt CRM" },
  description: "Edapt's attention allocator: who deserves a human, when, and with which offer.",
  applicationName: "Edapt CRM",
  appleWebApp: { capable: true, title: "Edapt CRM", statusBarStyle: "default" },
  icons: { apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#111111",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <HydrationGate>{children}</HydrationGate>
        <ServiceWorker />
        <ClientErrorReporter />
      </body>
    </html>
  );
}
