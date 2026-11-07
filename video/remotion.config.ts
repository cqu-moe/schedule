/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";
import { productUiConfig } from "./bundler-override.mjs";

Config.setRspack(true);
Config.setVideoImageFormat("png");
Config.overrideRspackConfig(productUiConfig);
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);
