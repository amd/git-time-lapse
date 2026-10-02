// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
//@ts-check
"use strict";

const path = require("path");
const { execSync } = require("child_process");
const webpack = require("webpack");

const pkg = require("./package.json");
const appVersion = pkg.displayName || "unknown";
let sourceCommit = "unknown";
try { sourceCommit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim(); } catch { /* not in a git repo */ }

/** ts-loader options shared by both bundles; transpileOnly keeps builds fast
 * and lets files outside src/ (the ../shared code) compile without a rootDir
 * constraint. */
const tsRule = {
  test: /\.ts$/,
  exclude: /node_modules/,
  use: [{ loader: "ts-loader", options: { transpileOnly: true } }],
};

/** Extension host bundle (Node). Includes the shared git backend + types. */
/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: "node",
  mode: "none",
  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  externals: { vscode: "commonjs vscode" },
  resolve: { extensions: [".ts", ".js"] },
  module: { rules: [tsRule] },
  devtool: "nosources-source-map",
  infrastructureLogging: { level: "log" },
};

/** Webview bundle (web). Includes the shared UI. */
/** @type {import('webpack').Configuration} */
const webviewConfig = {
  target: "web",
  mode: "none",
  entry: "./src/webview/main.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "webview.js",
  },
  resolve: {
    extensions: [".ts", ".js"],
    alias: {
      // The shared UI (../shared) imports highlight.js but has no node_modules;
      // resolve it to this shell's install.
      "highlight.js": path.resolve(__dirname, "node_modules/highlight.js"),
    },
  },
  module: {
    rules: [
      tsRule,
      {
        // hljs theme CSS as raw strings, injected into a <style> by the shared UI.
        test: /\.css$/,
        include: /highlight\.js[\\/]styles/,
        type: "asset/source",
      },
      {
        // The shared UI's own style.css is injected via style-loader.
        test: /\.css$/,
        exclude: /highlight\.js[\\/]styles/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    new webpack.DefinePlugin({
      __APP_VERSION__: JSON.stringify(appVersion),
      __SOURCE_COMMIT__: JSON.stringify(sourceCommit),
    }),
  ],
  devtool: "nosources-source-map",
};

module.exports = [extensionConfig, webviewConfig];
