import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        panel: "8px",
      },
      colors: {
        background: "var(--color-canvas)",
        foreground: "var(--color-ink)",
        border: "var(--color-line)",
        input: "var(--color-line)",
        ring: "var(--color-teal)",
        destructive: {
          DEFAULT: "var(--color-rust)",
          foreground: "#ffffff",
        },
        primary: {
          DEFAULT: "var(--color-teal)",
          foreground: "#ffffff",
        },
        secondary: {
          DEFAULT: "var(--color-panel)",
          foreground: "var(--color-ink)",
        },
        muted: {
          DEFAULT: "var(--color-muted)",
          foreground: "var(--color-muted)",
        },
        accent: {
          DEFAULT: "var(--color-panel)",
          foreground: "var(--color-ink)",
        },
        popover: {
          DEFAULT: "var(--color-panel)",
          foreground: "var(--color-ink)",
        },
        card: {
          DEFAULT: "var(--color-panel)",
          foreground: "var(--color-ink)",
        },
        canvas: "var(--color-canvas)",
        ink: "var(--color-ink)",
        line: "var(--color-line)",
        panel: "var(--color-panel)",
        rail: "var(--color-rail)",
        surface: "var(--color-surface)",
        modelblue: "var(--color-blue)",
        bluesoft: "var(--color-blue-soft)",
        violetsoft: "var(--color-violet-soft)",
        teal: "var(--color-teal)",
        rust: "var(--color-rust)",
        brass: "var(--color-brass)",
      },
      fontFamily: {
        body: ["var(--font-body)"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        hairline: "inset 0 0 0 1px var(--color-line)",
      },
    },
  },
  plugins: [animate],
};

export default config;

