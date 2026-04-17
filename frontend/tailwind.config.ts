import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', '"Segoe UI"', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eefcf9',
          100: '#d4f7ef',
          500: '#0f766e',
          600: '#0b5f59',
          700: '#094945',
        },
      },
      boxShadow: {
        panel: '0 20px 60px -32px rgba(15, 118, 110, 0.55)',
      },
    },
  },
  plugins: [],
} satisfies Config;