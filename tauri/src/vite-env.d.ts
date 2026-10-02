// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/// <reference types="vite/client" />

// hljs theme CSS imported as raw strings via Vite's ?raw suffix.
declare module "*.css?raw" {
  const content: string;
  export default content;
}
