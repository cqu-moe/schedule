import { resolve } from "node:path";

export const productUiConfig = (config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...config.resolve?.alias,
      react: resolve("node_modules/react"),
      "react-dom": resolve("node_modules/react-dom"),
    },
  },
});
