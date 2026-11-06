import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Port 5173 (strict): 0G's Privy sign-in only works on localhost 3000, 3001 or 5173.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, strictPort: true },
});
