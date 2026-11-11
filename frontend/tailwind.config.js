/** @type {import('tailwindcss').Config} */
// theme.colors 一律指回 src/app.css 的 :root token，这里不出现第二个色值。
// rgb(... / <alpha-value>) 的写法是为了保住 bg-accent/20 这类透明度用法：
// 直接写 var(--accent) 的话 tailwind 算不出 alpha，那几处会静默变成不透。
const ink = (n) => "rgb(var(--ink-rgb-" + n + ") / <alpha-value>)";
const chan = (name) => "rgb(var(--" + name + "-rgb) / <alpha-value>)";
export default {
  content: ["./index.html", "./src/**/*.{svelte,ts,js}"],
  theme: {
    extend: {
      colors: {
        bg: ink(0),
        surface: ink(1),
        "surface-2": ink(2),
        "surface-3": ink(3),
        border: chan("line"),
        muted: chan("text-3"),
        accent: chan("accent"),
        "accent-2": chan("accent-2"),
        danger: chan("danger"),
        success: chan("success"),
        warn: chan("warn"),
        info: chan("info"),
      },
      borderRadius: {
        ctl: "var(--r-1)",
        card: "var(--r-2)",
        panel: "var(--r-3)",
      },
      fontSize: {
        "2xs": ["var(--fs-2xs)", { lineHeight: "1.35" }],
        xs2: ["var(--fs-xs)", { lineHeight: "1.35" }],
        sm2: ["var(--fs-sm)", { lineHeight: "1.4" }],
        base2: ["var(--fs-base)", { lineHeight: "1.45" }],
        md2: ["var(--fs-md)", { lineHeight: "1.4" }],
        lg2: ["var(--fs-lg)", { lineHeight: "1.35" }],
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
