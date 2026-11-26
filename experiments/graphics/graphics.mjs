import { checkSupport, createKernel } from './assets/unkernel/web.mjs';
import { createStreamLink, createWland } from 'wland/client';

const asset = (file) => new URL(`./assets/${file}`, import.meta.url).href;
const status = document.querySelector('#status');
const diagnostics = document.querySelector('#diagnostics');
const desktop = document.querySelector('#desktop');
const emacs = document.querySelector('#emacs');
const cube = document.querySelector('#cube');
const stop = document.querySelector('#stop');
const icd = '/usr/share/vulkan/icd.d/kw_icd.json';
const readyFile = '/tmp/unkernel-doom-graphics-ready';
let vm;
let compositor;
let listener;
const doomReady = `(progn
  (unless (and (display-graphic-p) (not init-file-had-error) (fboundp 'doom-version) (require 'evil nil t))
    (error "Graphical Doom did not initialize"))
  (setq frame-title-format "Doom Emacs · %b")
  (write-region (format "Doom Emacs %s · Wayland · PID %s\\n" (doom-version) (emacs-pid)) nil "${readyFile}" nil 'silent))`;

async function launch(button, command, args, env) {
  const guest = vm;
  if (!guest) return;
  button.disabled = true;
  diagnostics.textContent += `\n$ ${command} ${args.join(' ')}\n`;
  try {
    if (button === emacs) await guest.exec('/bin/rm', ['-f', readyFile]);
    const proc = await guest.spawn('/usr/lib/kw/bin/wland', [command, ...args], { pty: false, env });
    if (button === emacs) {
      void guest.exec('/usr/bin/timeout', ['35', '/bin/sh', '-c', 'until test -s "$1"; do sleep 1; done; cat "$1"', 'sh', readyFile])
        .then((result) => { if (guest === vm && result.exitCode === 0) diagnostics.textContent += result.stdout; })
        .catch(console.error);
    }
    const [end, stdout, stderr] = await Promise.all([
      proc.ended, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    diagnostics.textContent += stdout + stderr;
    if (end.type !== 'exit' || end.code !== 0) status.textContent = `${command} завершился с ошибкой. Подробности в диагностике.`;
  } catch (error) {
    diagnostics.textContent += error.message;
    status.textContent = `Не удалось открыть ${command}.`;
  } finally {
    if (vm) button.disabled = false;
  }
}

async function run() {
  const support = await checkSupport();
  if (!support.ok) throw new Error(`Для запуска Linux нужен WebAssembly JSPI. ${support.problems.join(' ')}`);
  if (!navigator.gpu) throw new Error('Нужен браузер с WebGPU. Откройте эту страницу в актуальном Chrome или Edge.');

  status.textContent = 'Загружаем локальный образ Debian…';
  diagnostics.textContent = '';
  const response = await fetch(asset('desktop.kwsparse.gz'));
  if (!response.ok) throw new Error('Образ графического режима ещё не собран.');
  const template = await response.bytes();
  vm = await createKernel({
    worker: true,
    memoryMiB: 1024,
    distro: asset('debian.erofs'),
    disks: [{ kind: 'data', template, mode: 'snapshot' }],
    shm: true,
    vk: true,
  });
  listener = vm.vsock.listen(1023);
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (let conn = await listener.accept(); conn; conn = await listener.accept()) yield conn;
    },
    close: () => listener.close(),
  };
  compositor = await createWland({
    container: desktop,
    wasm: asset('wland.wasm'),
    link: createStreamLink(stream),
    buffers: {
      async open(handle) {
        if (handle.kind !== 'kwshm') throw new Error(`Неизвестный тип буфера Wayland: ${handle.kind}`);
        return vm.shm.openId(handle.id);
      },
      async read(file, offset, dst) { dst.set(await file.read(offset, dst.length)); },
      close: (file) => void file.close(),
    },
    gpu: {
      resolveExternal: (ref) => vm.vk.externalImage(ref),
      release: (image) => image.close(),
    },
    onEvent(event) {
      if (event.type === 'error') diagnostics.textContent += `\nWayland: ${event.detail}`;
    },
  });
  emacs.disabled = false;
  stop.disabled = false;
  status.textContent = 'Debian запущен. Проверяем Vulkan на WebGPU…';
  const guest = vm;
  const info = await guest.exec('/usr/bin/vulkaninfo', ['--summary'], { env: { VK_ICD_FILENAMES: icd } });
  if (guest !== vm) return;
  diagnostics.textContent += info.stdout + info.stderr;
  const ready = info.exitCode === 0 && /kwvk.*WebGPU/i.test(info.stdout);
  cube.disabled = !ready;
  status.textContent = ready ? 'Debian готов. Vulkan использует WebGPU.' : 'Debian готов. Vulkan не прошёл проверку. Откройте диагностику.';
}

emacs.addEventListener('click', () => void launch(emacs, 'emacs', [
  '--init-directory=/home/user/.config/emacs', '/home/user/notes.org', '--eval', doomReady,
], { GDK_BACKEND: 'wayland' }));
cube.addEventListener('click', () => void launch(cube, 'vkcube', ['--wsi', 'wayland'], { VK_ICD_FILENAMES: icd }));
stop.addEventListener('click', async () => {
  const current = vm;
  vm = undefined;
  for (const button of [emacs, cube, stop]) button.disabled = true;
  compositor?.dispose();
  listener?.close();
  await current?.stop();
  status.textContent = 'Виртуальная машина выключена. Обновите страницу для нового сеанса.';
});
void run().catch((error) => {
  status.textContent = error.message;
  diagnostics.textContent = error.stack ?? error.message;
});
