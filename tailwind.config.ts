import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "rgba(255,255,255,0.03)",
          card: "rgba(255,255,255,0.04)",
          border: "rgba(255,255,255,0.07)",
        },
      },
      boxShadow: {
        glow: "0 0 20px rgba(52, 211, 153, 0.15)",
        "glow-sm": "0 0 10px rgba(52, 211, 153, 0.1)",
        "glow-lg": "0 0 40px rgba(52, 211, 153, 0.2)",
        glass: "inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 3px rgba(0,0,0,0.4)",
      },
    },
  },
  plugins: [],
};
export default config;
