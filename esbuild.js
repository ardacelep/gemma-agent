// Bundles the extension into dist/extension.js for fast activation.
// Tests + typecheck still use the tsc output in out/ (see `npm run compile`).
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('esbuild: watching…');
  } else {
    await esbuild.build(options);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
