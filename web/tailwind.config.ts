import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Warm palette — Claude.ai inspired parchment aesthetic
        surface: {
          DEFAULT: "#f5f5f0",         // Warm parchment (Claude.ai bg)
          secondary: "#eae8e1",       // Slightly darker warm (sidebar)
          dark: "#2b2a27",            // Warm dark brown-gray (Claude.ai dark)
          "dark-secondary": "#1f1e1b", // Deeper warm dark
        },
        border: {
          DEFAULT: "rgba(0,0,0,0.08)", // Subtle light border
          dark: "rgba(255,255,255,0.08)", // Subtle dark border
        },
        accent: {
          // Claude.ai-aligned: stone-900 near-black for primary actions,
          // matching the "black send button" pattern. Indigo retired
          // (user feedback: no purple/indigo in interactive elements).
          DEFAULT: "#1c1917", // stone-900
          hover: "#292524",   // stone-800
          dark: "#f5f5f4",    // stone-100 — inverted for dark mode
        },
        // Inline text links — Claude.ai terracotta (warm, distinct from primary).
        // Use `text-link dark:text-link-dark` or set explicitly on anchors.
        link: {
          DEFAULT: "#ae5630",
          dark: "#d4956b",
        },
        // User message bubble — warm beige like Claude.ai
        "user-bubble": {
          DEFAULT: "#ddd9ce",  // Warm tan (Claude.ai user msg)
          dark: "#393937",     // Dark mode user bubble
        },
        // Muted text colors
        muted: {
          DEFAULT: "#6b6a68", // Warm muted (Claude.ai secondary text)
          dark: "#9a9893",    // Dark mode muted
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        // Serif for assistant responses — Claude.ai uses "Tiempos Text" (commercial).
        // We use ui-serif (renders as Apple's "New York" on macOS, closest free match)
        // with Iowan Old Style (another macOS system serif) as fallback.
        serif: [
          "ui-serif",
          "Iowan Old Style",
          "Palatino Linotype",
          "Georgia",
          "serif",
        ],
        mono: [
          "SF Mono",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      fontSize: {
        // Slightly larger body text for readability
        body: ["0.9375rem", { lineHeight: "1.6" }], // 15px
      },
    },
  },
  plugins: [],
} satisfies Config;
