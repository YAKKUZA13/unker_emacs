import { createWriteStream } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { build } from 'esbuild';
import { bundledBoot, CowDisk, createKernel, fetchDistro, readKwsparse, SparseBase } from 'unkernel-graphics/node';

const output = resolve('dist/local-graphics');
const sdk = resolve('node_modules/unkernel-graphics/dist');
const doomImage = resolve('dist/emacs.erofs');
const reuse = process.argv.includes('--reuse');
await access(doomImage).catch(() => { throw new Error('Build the Doom image with npm run build first.'); });
const wasm = await readFile(resolve(sdk, 'unkernel.wasm'));
const distro = await fetchDistro('debian');
const assets = resolve(output, 'assets');
await mkdir(assets, { recursive: true });
await cp('experiments/graphics', output, { recursive: true, filter: (path) => !path.endsWith('graphics.mjs') });
await cp(sdk, resolve(assets, 'unkernel'), { recursive: true });
await copyFile('node_modules/wland/dist/wland.wasm', resolve(assets, 'wland.wasm'));
await copyFile(distro, resolve(assets, 'debian.erofs'));
await build({ entryPoints: ['experiments/graphics/graphics.mjs'], outfile: resolve(output, 'graphics.mjs'), bundle: true, format: 'esm', external: ['./assets/unkernel/web.mjs'] });

const seed = resolve(assets, 'desktop.kwsparse.gz');
const template = await readKwsparse(reuse ? await readFile(seed) : bundledBoot(await WebAssembly.compile(wasm)).datadisk);
const disk = new CowDisk(new SparseBase(template.size, template.map()));
const vm = await createKernel({
  distro,
  disks: [disk, { kind: 'file', path: doomImage, readOnly: true }],
  memoryMiB: 1536,
  net: { kind: 'net', backend: { kind: 'direct' } },
});
try {
  console.log('Preparing graphical Doom Emacs and Vulkan tools in Debian…');
  const install = await vm.spawn('/bin/sh', ['-ec', `
    export DEBIAN_FRONTEND=noninteractive
    ${reuse ? '' : 'apt-get -o Acquire::Retries=2 update -qq'}
    apt-get -o Acquire::Retries=2 install -y -qq --no-install-recommends emacs-pgtk vulkan-tools fonts-dejavu-core git ripgrep fd-find
    mkdir -p /mnt/doom
    mount -t erofs -o ro /dev/wdc /mnt/doom
    install -d -o user -g user /home/user/.config /home/user/.local/share
    cp -a /mnt/doom/home/user/.config/emacs /mnt/doom/home/user/.config/doom /home/user/.config/
    cp -a /mnt/doom/home/user/.local/share/doom /home/user/.local/share/
    umount /mnt/doom
    sudo -H -u user /home/user/.config/emacs/bin/doom -! sync -r -U
    apt-get clean
    sync
  `], { user: 'root', pty: false });
  const [end] = await Promise.all([
    install.ended,
    pipeline(install.stdout, process.stdout, { end: false }),
    pipeline(install.stderr, process.stderr, { end: false }),
  ]);
  if (end.type !== 'exit' || end.code !== 0) throw new Error(`Debian package installation failed: ${JSON.stringify(end)}`);
  const { parts } = await disk.exportParts();
  await pipeline(new Blob(parts).stream(), createGzip(), createWriteStream(`${seed}.tmp`));
  await rename(`${seed}.tmp`, seed);
} finally {
  await vm.stop();
}
console.log('Open /unkernel-emacs/local-graphics/ through npm run preview.');
