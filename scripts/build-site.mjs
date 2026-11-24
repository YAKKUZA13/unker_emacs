import { copyFile, cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const output = resolve('dist');
const sdk = dirname(require.resolve('unkernel/package.json'));

await mkdir(resolve(output, 'vendor'), { recursive: true });
await cp('site', output, { recursive: true, filter: (file) => basename(file) !== 'navigation.mjs' });
await build({
  entryPoints: ['site/navigation.mjs'],
  outfile: resolve(output, 'navigation.mjs'),
  bundle: true,
  format: 'esm',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

await cp(resolve(sdk, 'dist'), resolve(output, 'vendor', 'unkernel'), {
  recursive: true,
  filter: (file) => !/[\\/](?:_chunks[\\/]node\.mjs|cli-imports\.mjs|(?:cli|node|virgl)\.[^\\/]+)$/.test(file),
});
await copyFile(resolve(sdk, 'LICENSE'), resolve(output, 'vendor', 'unkernel', 'LICENSE'));
await copyFile(resolve(sdk, 'LICENSE-MIT'), resolve(output, 'vendor', 'unkernel', 'LICENSE-MIT'));

for (const [name, file] of [
  ['vue', 'node_modules/vue/LICENSE'],
  ['ui-sdk-vue', 'node_modules/@ui-sdk/vue/LICENSE'],
  ['ui-sdk-core', 'node_modules/@ui-sdk/core/LICENSE'],
]) {
  await copyFile(file, resolve(output, 'vendor', `${name}-LICENSE`));
}

for (const [name, files] of [
  ['xterm', ['lib/xterm.mjs', 'css/xterm.css', 'LICENSE']],
  ['addon-fit', ['lib/addon-fit.mjs', 'LICENSE']],
]) {
  const moduleDirectory = resolve('node_modules', '@xterm', name);
  const target = resolve(output, 'vendor', name);
  await mkdir(target, { recursive: true });
  for (const file of files) {
    await copyFile(resolve(moduleDirectory, file), resolve(target, file.split('/').at(-1)));
  }
}
