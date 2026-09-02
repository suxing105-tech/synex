/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{svelte,ts,js}"],
  theme: {
    extend: {
      colors: {
        bg: "#0e0e10",
        surface: "#18181b",
        "surface-2": "#27272a",
        "surface-3": "#323237",
        border: "#2e2e33",
        muted: "#8a8a8e",
        accent: "#818cf8",
        "accent-2": "#f472b6",
        danger: "#fb7185",
        success: "#34d399",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          '"SF Mono"',
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
