/** @type {import('tailwindcss').Config} */
// theme.colors 一律指回 src/app.css 的 :root token，这里不出现第二个色值。
// rgb(... / <alpha-value>) 的写法是为了保住 bg-accent/20 这类透明度用法：
// 直接写 var(--accent) 的话 tailwind 算不出 alpha，那几处会静默变成不透。
const ink = (n) => "rgb(var(--ink-rgb-" + n + ") / <alpha-value>)";
const chan = (name) => "rgb(var(--" + name + "-rgb) / <alpha-value>)";
export default {
  content: ["./index.html", "./src/**/*.{svelte,ts,js}"],
  theme: {
    // 字号七档定义在 theme.fontSize（不是 theme.extend）：这是故意的，为的是把 Tailwind 内置的
    // text-xs / text-sm / text-base / text-lg / text-xl 一并占掉，全站只剩「text-sm 就是 13px」
    // 一个说法。代价写进 AGENTS.md §3.1：内置的 text-2xl 及以上从这一版起不存在，写了不报错但没样式。
    // 行高统一挂 --lh-label（三轨的默认轨），要读成段的段落自己换 --lh-read。
    fontSize: {
      "2xs": ["var(--fs-2xs)", { lineHeight: "var(--lh-label)" }],
      xs: ["var(--fs-xs)", { lineHeight: "var(--lh-label)" }],
      sm: ["var(--fs-sm)", { lineHeight: "var(--lh-label)" }],
      base: ["var(--fs-base)", { lineHeight: "var(--lh-label)" }],
      md: ["var(--fs-md)", { lineHeight: "var(--lh-label)" }],
      lg: ["var(--fs-lg)", { lineHeight: "var(--lh-label)" }],
      xl: ["var(--fs-xl)", { lineHeight: "var(--lh-label)" }],
    },
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
      // 字族只指回 src/app.css 的 :root token，和 theme.colors 同一套做法：这里出现第二份
      // 字体栈，preflight 塞给 html 的就和 @font-face 声明的不再是同一件事（改之前正是这样，
      // 全站没有 --font-mono，却已经有地方在写 var(--font-mono)）。
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};
