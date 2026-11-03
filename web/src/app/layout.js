import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// `template` applies to child segments only, so `default` is what the root
// itself and any page without a title of its own render.
export const metadata = {
  title: {
    default: "J1SPA Decision Support System",
    template: "%s | J1SPA",
  },
  description:
    "Sales, inventory, forecasting and decision support for J1 Scooter Parts and Accessories",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
