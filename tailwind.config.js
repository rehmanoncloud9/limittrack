module.exports = {
  content: ["./index.html", "./renderer.js"],
  theme: {
    extend: {
      fontFamily: { sans: ["var(--font-ui)"] },
      fontSize: {
        xs: ["0.8125rem", { lineHeight: "1.25rem", letterSpacing: "-0.005em" }],
        sm: ["0.875rem", { lineHeight: "1.375rem", letterSpacing: "-0.008em" }],
        base: ["1rem", { lineHeight: "1.5rem", letterSpacing: "-0.015em" }],
        section: ["1.125rem", { lineHeight: "1.5rem", letterSpacing: "-0.02em" }],
        xl: ["1.5rem", { lineHeight: "1.875rem", letterSpacing: "-0.03em" }],
        "2xl": ["2rem", { lineHeight: "2.375rem", letterSpacing: "-0.035em" }],
      },
      colors: Object.fromEntries([
        "canvas", "surface", "subtle", "ink", "muted", "line", "accent-soft", "accent-ink",
        "success", "success-soft", "warning", "danger", "danger-soft",
      ].map((name) => [name, `rgb(var(--${name}) / <alpha-value>)`])),
    },
  },
};
