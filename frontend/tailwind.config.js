/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand:  '#6366f1',
        panel:  '#0d0f14',
        panel2: '#151821',
        line:   '#1e2230',
        muted2: '#64748b',
        up:     '#22c55e',
        down:   '#ef4444',
      },
      animation: {
        pulseSoft: 'pulseSoft 2s ease-in-out infinite',
      },
      keyframes: {
        pulseSoft: {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.5 },
        },
      },
    },
  },
  plugins: [],
};
