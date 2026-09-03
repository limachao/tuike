/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* Apple macOS Sequoia 暗色基底 */
        bg: {
          primary: '#0a0a0f',
          secondary: '#141418',
          elevated: '#1c1c22',
        },
        glass: {
          DEFAULT: 'rgba(28, 28, 34, 0.55)',
          strong:  'rgba(28, 28, 34, 0.82)',
          border:  'rgba(255, 255, 255, 0.08)',
          borderStrong: 'rgba(255, 255, 255, 0.16)',
        },
        /* 金黄色主色系 */
        brand: {
          50:  '#FBF7E8',
          100: '#F5E9C4',
          200: '#EAD288',
          300: '#DFBB4E',
          400: '#D9B43E',
          500: '#D4AF37',   // 经典金 - 主色
          600: '#B8941F',
          700: '#947617',
          800: '#6F5810',
        },
        accent: {
          mint:  '#34D4A5',
          red:   '#FF5A5F',
          pink:  '#FF6BA9',
          indigo:'#8B7BFF',
        },
        text: {
          primary:   '#F2F3F8',
          secondary: '#A6ACBF',
          tertiary:  '#6D7386',
        },
      },
      boxShadow: {
        glass: '0 8px 32px 0 rgba(0, 0, 0, 0.40), 0 2px 8px 0 rgba(0, 0, 0, 0.20)',
        soft:  '0 4px 20px 0 rgba(0, 0, 0, 0.30)',
        glow:  '0 0 0 1px rgba(212,175,55,0.40), 0 8px 32px 0 rgba(212,175,55,0.25)',
        'gold-lg': '0 12px 40px -8px rgba(212,175,55,0.45), 0 4px 16px 0 rgba(212,175,55,0.20)',
      },
      backgroundImage: {
        'grid-pattern':
          'radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)',
        'gold-aurora':
          'radial-gradient(circle at 15% 0%, rgba(212,175,55,0.18), transparent 55%), radial-gradient(circle at 85% 15%, rgba(184,148,31,0.12), transparent 55%), radial-gradient(circle at 50% 100%, rgba(139,123,255,0.08), transparent 60%)',
      },
      borderRadius: {
        xl2: '1.25rem',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Helvetica Neue"',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
