/**
 * ROSE IA build pipeline.
 *
 * Produces a loadable Manifest V3 extension in ./dist.
 *
 * Three passes are required because the targets have incompatible module
 * formats: MV3 content scripts cannot be ES modules, the service worker can be,
 * and the HTML pages need code-split ES chunks.
 */
import { build } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeManifest } from './manifest.mjs';
import { generateIcons } from './gen-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const isProd = process.argv.includes('--prod');

const alias = { '@': path.join(root, 'src') };

function log(msg) {
  process.stdout.write(`\x1b[35m[build]\x1b[0m ${msg}\n`);
}

async function bundle({ name, input, format, fileName, emptyOutDir }) {
  log(`bundling ${name} -> ${fileName}`);
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    resolve: { alias },
    define: { 'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development') },
    esbuild: { legalComments: 'none' },
    build: {
      outDir: dist,
      emptyOutDir,
      minify: isProd ? 'esbuild' : false,
      target: 'chrome110',
      sourcemap: isProd ? false : 'inline',
      rollupOptions: {
        input: { [name]: input },
        output: {
          format,
          inlineDynamicImports: true,
          entryFileNames: fileName,
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          ...(format === 'iife' ? { name: 'RoseBundle' } : {}),
        },
      },
    },
  });
}

async function bundlePages() {
  log('bundling html pages (popup, options, sidepanel, dashboard)');
  await build({
    root: path.join(root, 'src'),
    configFile: false,
    logLevel: 'warn',
    base: './',
    resolve: { alias },
    define: { 'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development') },
    build: {
      outDir: dist,
      emptyOutDir: false,
      minify: isProd ? 'esbuild' : false,
      target: 'chrome110',
      sourcemap: isProd ? false : 'inline',
      rollupOptions: {
        input: {
          popup: path.join(root, 'src/popup/popup.html'),
          options: path.join(root, 'src/options/options.html'),
          sidepanel: path.join(root, 'src/sidepanel/sidepanel.html'),
          dashboard: path.join(root, 'src/dashboard/dashboard.html'),
        },
      },
    },
  });
}

/**
 * The demo harness lives outside `src/`, so it cannot share the pages build
 * (Vite requires HTML inputs to be inside the configured root). It gets its own
 * pass rooted at `demo/` and is emitted to `dist/demo/`.
 */
async function bundleDemo() {
  log('bundling demo harness -> demo/');
  await build({
    root: path.join(root, 'demo'),
    configFile: false,
    logLevel: 'warn',
    base: './',
    define: { 'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development') },
    build: {
      outDir: path.join(dist, 'demo'),
      emptyOutDir: true,
      minify: isProd ? 'esbuild' : false,
      target: 'chrome110',
      sourcemap: isProd ? false : 'inline',
      rollupOptions: {
        input: { demo: path.join(root, 'demo/demo.html') },
      },
    },
  });
}

function copyStatic() {
  log('copying static assets');
  const publicDir = path.join(root, 'public');
  if (fs.existsSync(publicDir)) {
    for (const entry of fs.readdirSync(publicDir)) {
      if (entry === 'icons') continue;
      fs.cpSync(path.join(publicDir, entry), path.join(dist, entry), { recursive: true });
    }
  }
  generateIcons(path.join(dist, 'icons'));
  writeManifest(path.join(dist, 'manifest.json'), { prod: isProd });
}

async function main() {
  const started = Date.now();
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  await bundle({
    name: 'content',
    input: path.join(root, 'src/content/index.ts'),
    format: 'iife',
    fileName: 'content.js',
    emptyOutDir: false,
  });

  await bundle({
    name: 'background',
    input: path.join(root, 'src/background/index.ts'),
    format: 'es',
    fileName: 'background.js',
    emptyOutDir: false,
  });

  await bundlePages();
  await bundleDemo();
  copyStatic();

  const bytes = fs
    .readdirSync(dist, { withFileTypes: true })
    .reduce((acc, e) => acc + (e.isFile() ? fs.statSync(path.join(dist, e.name)).size : 0), 0);

  log(`done in ${Date.now() - started}ms (${isProd ? 'production' : 'development'} mode)`);
  log(`output: ${dist}`);
}

main().catch((err) => {
  process.stderr.write(`\n\x1b[31m[build] FAILED\x1b[0m\n${err?.stack || err}\n`);
  process.exit(1);
});
