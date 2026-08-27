import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "APITOLHEIRO Lab",
  description: "Radar de análise pré-jogo com consumo controlado de dados.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
