import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Finsk Tutor",
  description: "En rolig, vedvarende finsk samtaletræner.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="da">
      <body>{children}</body>
    </html>
  );
}
