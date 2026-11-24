import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createKernel, fetchDistro } from 'unkernel/node';
import './build-site.mjs';

const output = resolve('dist');

const distro = await fetchDistro('alpine');
const builder = await createKernel({
  distro,
  memoryMiB: 1536,
  net: { kind: 'net', backend: { kind: 'direct' } },
});

try {
  console.log('Installing Doom Emacs in the Alpine image…');
  const setup = await builder.spawn('/bin/sh', ['-es'], { user: 'root', pty: false });
  const script = (await readFile('scripts/doom-install.sh', 'utf8')).replaceAll('\r\n', '\n');
  const [ended] = await Promise.all([
    setup.ended,
    new Blob([script]).stream().pipeTo(setup.stdin),
    pipeline(setup.stdout, process.stdout, { end: false }),
    pipeline(setup.stderr, process.stderr, { end: false }),
  ]);
  if (ended.type !== 'exit' || ended.code !== 0) throw new Error(`Image build failed: ${JSON.stringify(ended)}`);

  const image = await builder.spawn('/bin/cat', ['/tmp/emacs.erofs'], { pty: false });
  const errors = new Response(image.stderr).text();
  await pipeline(image.stdout, createWriteStream(resolve(output, 'emacs.erofs')));
  const imageExit = await image.ended;
  if (imageExit.type !== 'exit' || imageExit.code !== 0) throw new Error(await errors);
  await errors;
} finally {
  builder.stop();
  await builder.exited;
}

console.log('Checking the generated image…');
const guest = await createKernel({ distro: resolve(output, 'emacs.erofs'), memoryMiB: 512 });
try {
  const result = await guest.exec('/usr/bin/emacs', ['-Q', '--batch', '--eval', '(princ emacs-version)']);
  if (result.exitCode !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  const doom = await guest.exec('/home/user/.config/emacs/bin/doom', ['version']);
  if (doom.exitCode !== 0) throw new Error(`${doom.stdout}\n${doom.stderr}`);
  const editor = await guest.spawn('/usr/bin/emacs', ['-nw', '--init-directory=/home/user/.config/emacs', '--eval', `
    (condition-case err
        (progn
          (unless (and (not init-file-had-error) (fboundp 'doom-version) (require 'evil nil t))
            (error "Doom or Evil failed to initialize"))
          (send-string-to-terminal "doom-pty-ready")
          (kill-emacs 0))
      (error (send-string-to-terminal (error-message-string err)) (kill-emacs 1)))
  `], { term: 'xterm-256color', env: { LANG: 'C.UTF-8' } });
  const [editorExit, editorOutput] = await Promise.all([editor.ended, new Response(editor.output).text()]);
  if (editorExit.type !== 'exit' || editorExit.code !== 0 || !editorOutput.includes('doom-pty-ready')) {
    throw new Error(`Doom PTY startup failed: ${JSON.stringify(editorExit)}\n${editorOutput}`);
  }
  console.log(`Built dist/ with GNU Emacs ${result.stdout.trim()}\n${doom.stdout.trim()}`);
  await writeFile(resolve(output, '.nojekyll'), '');
} finally {
  guest.stop();
  await guest.exited;
}
