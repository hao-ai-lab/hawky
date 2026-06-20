import type { Config } from "tailwindcss";

// Mirrors the iOS app's DesignTokens: dark-first canvas, warm amber accent,
// rounded continuous corners, paper/glass surfaces.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Canvas — CSS-var backed so light/dark themes flip automatically.
        canvas: "var(--bg)",
        paper: "var(--paper)",
        "paper-light": "#FFF9F4", // warm off-white (light)
        // Warm amber accent (oklch(0.75 0.13 70) ≈ #E0A34B)
        accent: "#E0A34B",
        "accent-soft": "rgba(224,163,75,0.12)",
        // Status
        ok: "#34C759",
        danger: "#FF453A",
        warn: "#FF9F0A",
        live: "#FF3B30",
      },
      borderRadius: {
        glass: "28px",
        bubble: "22px",
        card: "20px",
        pill: "14px",
      },
      fontFamily: {
        // Inter — the editorial typeface (Thinking Machines look). Default sans.
        sans: ["InterVariable", "Inter", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glass: "0 4px 24px rgba(0,0,0,0.35)",
        pip: "0 4px 14px rgba(0,0,0,0.45)",
      },
    },
  },
  plugins: [],
} satisfies Config;
