import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      borderRadius: {
        panel: "8px",
      },
      colors: {
        canvas: "var(--color-canvas)",
        ink: "var(--color-ink)",
        muted: "var(--color-muted)",
        line: "var(--color-line)",
        panel: "var(--color-panel)",
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
  plugins: [],
};

export default config;

