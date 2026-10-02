// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
// hljs theme CSS is imported as a raw string (webpack asset/source); the shared
// UI's own style.css is a side-effect import via style-loader.
declare module "*.css" {
  const content: string;
  export default content;
}
