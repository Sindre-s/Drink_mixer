/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "#10141B",
        panel: "#161C26",
        panelSoft: "#1C2430",
        accent: "#D69A3C",
        accentSoft: "#B17D2E",
        danger: "#C94242",
        ok: "#2E9D58"
      },
      boxShadow: {
        soft: "0 8px 24px rgba(0,0,0,0.35)"
      }
    }
  },
  plugins: []
};
