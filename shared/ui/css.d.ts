// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
// Side-effect CSS import (bundler injects it). The default export type covers
// raw-string CSS imports in shells; app.ts only uses `import "./style.css"`.
declare module "*.css" {
  const content: string;
  export default content;
}
