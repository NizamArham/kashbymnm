import plugin from "tailwindcss/plugin";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [
    // A laptop-height window (about 820px or less): the sidebar tightens up so a whole menu still fits.
    // This is a variant of its own, not an entry in `screens`: a height-based screen in `screens` makes Tailwind stop
    // generating every min-[…] / max-[…] / max-lg: variant (they only exist while all screens are plain min-widths).
    plugin(({ addVariant }) => {
      addVariant("short", "@media (max-height: 820px)");
    }),
  ],
};
