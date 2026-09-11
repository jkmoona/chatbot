import type { Metadata } from "next";
import { Inter, Newsreader } from "next/font/google";

import { Nav } from "./nav";
import "./globals.css";

// latin-ext carries the Turkish characters (ş, ğ, ı, İ, ç, ö, ü).
const sans = Inter({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-sans",
});

const serif = Newsreader({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-serif",
});

export const metadata: Metadata = {
  title: "Document Q&A",
  description: "Ask questions about uploaded PDFs, in Turkish or English.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>
        <div className="shell">
          <header className="masthead">
            <h1>Document Q&amp;A</h1>
            <Nav />
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
