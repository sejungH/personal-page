import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "/",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        post: resolve(__dirname, "post.html"),
        write: resolve(__dirname, "write.html"),
        settings: resolve(__dirname, "settings.html"),
        logout: resolve(__dirname, "logout.html"),
        admin: resolve(__dirname, "admin.html"),
        user: resolve(__dirname, "user.html"),
      },
    },
  },
});
