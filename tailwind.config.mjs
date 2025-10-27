/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "media",
  content: [
    "./src/**/*.{astro,html,md,mdx,js,jsx,ts,tsx}",
    "./functions/**/*.{ts,js}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Inter', 'Segoe UI', 'Arial', 'sans-serif']
      }
    }
  },
  plugins: []
};
