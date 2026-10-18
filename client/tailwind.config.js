/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      // A laptop-height window (about 820px or less): the sidebar tightens up so a whole menu still fits.
      screens: { short: { raw: "(max-height: 820px)" } },
    },
  },
  plugins: [],
};
