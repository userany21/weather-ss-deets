import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#0b0d10",
        panel: "#14171c",
        border: "#22262d",
        text: "#e6e8eb",
        subtext: "#8b92a0",
        temp: "#d9534f",
        price: "#4a90d9",
        good: "#5cb85c",
        live: "#f0ad4e",
      },
    },
  },
  plugins: [],
};
export default config;
