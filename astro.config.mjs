import cloudflare from "@astrojs/cloudflare";
import tailwind from "@astrojs/tailwind";

export default {
  output: "server",
  adapter: cloudflare(),
  integrations: [tailwind()],
  server: { host: true, port: 4321 }
};
