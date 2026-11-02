import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const monorepoRoot = path.resolve(__dirname, '../../');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces .next/standalone: a self-contained server bundle with only
  // the traced runtime files, used by apps/web/Dockerfile for the VPS
  // deployment (see docs/production_environment.md, section 5).
  output: 'standalone',
  distDir: process.env.TUGPT_NEXT_DIST_DIR || '.next',
  // Required in monorepos: without this, file tracing for `standalone`
  // only looks inside apps/web and misses the @tugpt/* workspace packages
  // this app depends on (they live under packages/*, outside the tracing
  // root Next.js would otherwise infer).
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
