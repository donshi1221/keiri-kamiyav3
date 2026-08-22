import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // heic-convert は内部で libheif-js の wasm を Node.js の fs 経由で読み込むため、
  // Server Components のバンドル対象から外し、native require で読ませる
  // （node_modules/next/dist/docs/.../serverExternalPackages.md 参照。pdf-parse と同じ理由）。
  serverExternalPackages: ['pdf-parse', 'heic-convert'],
};

export default nextConfig;
