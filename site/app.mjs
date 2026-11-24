import { Terminal } from './vendor/xterm/xterm.mjs';
import { FitAddon } from './vendor/addon-fit/addon-fit.mjs';
import { checkSupport, createKernel } from './vendor/unkernel/web.mjs';
import { mountNavigation } from './navigation.mjs';

const notesPath = '/home/user/notes.org';
const boot = document.querySelector('#boot');
const bootTitle = document.querySelector('#boot-title');
const bootStage = document.querySelector('#boot-stage');
const bootLog = document.querySelector('#boot-log');
const openEmacs = document.querySelector('#open-emacs');
const inspectVm = document.querySelector('#inspect-vm');
const vmDialog = document.querySelector('#vm-dialog');
const vmOutput = document.querySelector('#vm-output');
const status = document.querySelector('#status');
const restart = document.querySelector('#restart');
const fileInput = document.querySelector('#file');
const controls = document.querySelectorAll('[data-session]');
const keyboard = document.querySelector('#keyboard');
const saveButton = document.querySelector('#save');
const keyButtons = document.querySelectorAll('[data-key]');
const workspace = document.querySelector('#workspace');
const workspacePath = document.querySelector('#workspace-path');
const machineState = document.querySelector('#machine-state');
const machineDisk = document.querySelector('#machine-disk');
const updateNavigation = mountNavigation(document.querySelector('#view-nav'), selectView);
const shellStatus = 'Терминал Alpine. Для команд от root используйте sudo.';

let vm;
let view = 'boot';
let ready = false;
let shuttingDown = false;
let saving = false;
let persistent = true;
let fallbackUrl;
let bootText = '';
let logFrame;
const bootDecoder = new TextDecoder();

function createPane(container, name, label) {
  const term = new Terminal({
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: 16,
    cursorBlink: true,
    scrollback: 1000,
    disableStdin: true,
    theme: { background: '#181922', foreground: '#edf0f6', cursor: '#d6baff' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let session;
  let running = false;
  let inputReady = false;

  function refit() {
    if (!container.hidden && term.element) fit.fit();
  }

  function write(data) {
    if (session) void session.write(data).catch((error) => report('Ошибка ввода в терминал.', error));
  }

  term.onData(write);
  term.onBinary((data) => write(Uint8Array.from(data, (byte) => byte.charCodeAt(0))));
  term.onResize(({ cols, rows }) => {
    if (session) void Promise.resolve(session.resize(cols, rows)).catch(console.error);
  });
  new ResizeObserver(refit).observe(container);

  return {
    term,
    write,
    get active() { return inputReady && ready; },
    show(visible) {
      container.hidden = !visible;
      if (visible && !term.element) {
        term.open(container);
        const textarea = container.querySelector('textarea');
        textarea.setAttribute('aria-label', label);
        textarea.setAttribute('autocorrect', 'off');
        textarea.setAttribute('autocapitalize', 'off');
        textarea.spellcheck = false;
      }
      refit();
    },
    async run(file, args) {
      if (running) return;
      running = true;
      term.reset();
      report(`Запускается ${label}…`);
      try {
        session = await vm.spawn(file, args, {
          user: 'user', cols: term.cols, rows: term.rows, term: 'xterm-256color',
          env: { LANG: 'C.UTF-8' },
        });
        term.options.disableStdin = false;
        if (view === 'shell' && name === 'shell') {
          report(shellStatus);
        }
        await session.output.pipeTo(new WritableStream({
          write(bytes) {
            return new Promise((resolve) => term.write(bytes, () => {
              if (!inputReady) {
                inputReady = true;
                updateControls();
              }
              resolve();
            }));
          },
        }));
        const ended = await session.ended;
        if (ended.type !== 'exit' || ended.code !== 0) throw new Error(JSON.stringify(ended));
        await flush();
        if (ready && !shuttingDown) term.writeln(`\r\n${label} завершён. Откройте вкладку, чтобы запустить снова.`);
      } catch (error) {
        if (ready && !shuttingDown) {
          term.writeln(`\r\n${label}: ${error.message}`);
          report(`Не удалось продолжить сеанс. ${error.message}`, error);
        }
      } finally {
        session = undefined;
        running = false;
        inputReady = false;
        term.options.disableStdin = true;
        updateControls();
      }
    },
  };
}

const panes = {
  emacs: createPane(document.querySelector('#terminal'), 'emacs', 'Doom Emacs'),
  shell: createPane(document.querySelector('#shell'), 'shell', 'Терминал Alpine'),
};

function bootTranscript() {
  return bootText.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\r/g, '');
}

function captureBoot(bytes) {
  bootText = (bootText + bootDecoder.decode(bytes, { stream: true })).slice(-48_000);
  if (logFrame === undefined && !boot.hidden) {
    logFrame = requestAnimationFrame(() => {
      logFrame = undefined;
      bootLog.textContent = bootTranscript();
      bootLog.scrollTop = bootLog.scrollHeight;
    });
  }
}

function updateControls() {
  const pane = panes[view];
  keyboard.disabled = !pane?.active;
  for (const button of controls) button.disabled = view !== 'emacs' || !pane?.active || (button === saveButton && saving);
  for (const button of keyButtons) {
    button.hidden = Boolean(button.dataset.view && button.dataset.view !== view);
    button.disabled = !pane?.active;
  }
  updateNavigation(view, ready);
  inspectVm.disabled = !ready;
  openEmacs.disabled = !ready;
}

function report(message, error) {
  status.textContent = message;
  if (error) console.error(error);
}

function showMachineState(state, label) {
  machineState.dataset.state = state;
  machineState.textContent = label;
}

inspectVm.addEventListener('click', async () => {
  vmOutput.textContent = 'Выполняются команды в Alpine Linux…';
  document.querySelector('#vm-boot-log').textContent = bootTranscript();
  vmDialog.showModal();
  try {
    const result = await vm.exec('/bin/sh', ['-ec', `
      printf '$ uname -a\\n'
      uname -a
      printf '\\n$ cat /etc/alpine-release\\n'
      cat /etc/alpine-release
      printf '\\n$ /usr/bin/emacs --version\\n'
      /usr/bin/emacs --version | head -n 1
      printf '\\n$ ps -o pid,comm | grep "[e]macs"\\n'
      ps -o pid,comm | grep '[e]macs' || true
    `]);
    vmOutput.textContent = result.stdout;
    if (result.exitCode !== 0) vmOutput.textContent += result.stderr;
  } catch (error) {
    vmOutput.textContent = `Не удалось выполнить команды в Alpine. ${error.message}`;
  }
});

function updateViewport() {
  const viewport = window.visualViewport;
  if (viewport?.scale === 1) {
    document.documentElement.style.setProperty('--viewport-height', `${viewport.height}px`);
  }
}
window.visualViewport?.addEventListener('resize', updateViewport);
updateViewport();

keyboard.addEventListener('click', () => panes[view]?.term.focus());
saveButton.addEventListener('click', async () => {
  if (saving || !panes.emacs.active) return;
  saving = true;
  updateControls();
  panes.emacs.term.focus();
  try {
    const result = await vm.exec('/usr/bin/emacsclient', ['--socket-name=unkernel-web', '--eval', `
      (with-current-buffer (window-buffer (selected-window))
        (unless buffer-file-name (user-error "No file in this buffer"))
        (save-buffer))
    `]);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim());
    await reportSaved();
  } catch (error) {
    report('Не удалось сохранить текущий файл.', error);
  } finally {
    saving = false;
    updateControls();
  }
});

const keys = {
  'ctrl-x': '\x18', 'ctrl-g': '\x07', 'ctrl-c': '\x03', 'ctrl-d': '\x04',
  'meta-x': '\x1bx', insert: 'i', enter: '\r', escape: '\x1b', tab: '\t',
};
const arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
for (const button of keyButtons) {
  button.addEventListener('click', () => {
    const pane = panes[view];
    if (!pane?.active) return;
    const key = button.dataset.key;
    const arrowPrefix = pane.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
    pane.write(keys[key] ?? arrowPrefix + arrows[key]);
    pane.term.focus();
  });
}

document.querySelector('#insert').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file || !panes.emacs.active) return;
  try {
    const text = (await file.text()).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    panes.emacs.term.paste(text);
    panes.emacs.term.focus();
  } catch (error) {
    report('Не удалось прочитать файл.', error);
  }
});

document.querySelector('#download').addEventListener('click', async () => {
  const button = document.querySelector('#download');
  button.disabled = true;
  try {
    const result = await vm.exec('/bin/cat', [notesPath], { encoding: 'buffer' });
    if (result.exitCode !== 0) {
      report('Сначала сохраните notes.org.');
      return;
    }
    const url = URL.createObjectURL(new Blob([result.stdout], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'notes.org';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    report('Подготовлена сохранённая версия notes.org.');
  } catch (error) {
    report('Не удалось скачать notes.org.', error);
  } finally {
    button.disabled = view !== 'emacs' || !panes.emacs.active;
  }
});

async function flush() {
  try {
    return (await vm?.sync()) === true && persistent;
  } catch (error) {
    persistent = false;
    machineDisk.textContent = 'Недоступен';
    report('Хранилище браузера недоступно. Скачайте notes.org.', error);
    return false;
  }
}

async function reportSaved() {
  const saved = await flush();
  report(saved ? 'Файл сохранён в этом браузере.' : 'Файл сохранён в сеансе. Скачайте notes.org.');
}

const emacsConfig = `(progn
  (unless (and (not init-file-had-error) (fboundp 'doom-version) (require 'evil nil t))
    (error "Doom Emacs did not load"))
  (require 'server)
  (setq server-name "unkernel-web")
  (server-start)
  (add-hook 'after-save-hook
    (lambda () (send-string-to-terminal "\\e]777;emacs-saved\\a")))
  (send-string-to-terminal "\\e]777;doom-ready\\a"))`;

function editorStatus() {
  return persistent ? 'Doom Emacs готов. Для ввода нажмите i.' : 'Скачайте notes.org перед выходом.';
}

panes.emacs.term.parser.registerOscHandler(777, (data) => {
  if (data === 'doom-ready') {
    if (view === 'emacs') report(editorStatus());
    return true;
  }
  if (data !== 'emacs-saved') return false;
  if (!saving) void reportSaved();
  return true;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && vm) void flush();
});
window.addEventListener('pagehide', () => {
  if (vm) void flush();
});
restart.addEventListener('click', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  restart.disabled = true;
  ready = false;
  updateControls();
  showMachineState('starting', 'Перезагрузка');
  report('Перезагружается виртуальная машина…');
  await flush();
  await vm?.stop();
  location.reload();
});

function selectView(next) {
  if (!ready) return;
  view = next;
  workspace.dataset.view = view;
  workspacePath.textContent = { boot: '/dev/hvc0', emacs: '~/notes.org', shell: '/bin/bash' }[view];
  boot.hidden = view !== 'boot';
  if (view === 'boot') bootLog.textContent = bootTranscript();
  for (const [name, pane] of Object.entries(panes)) pane.show(view === name);
  updateControls();

  if (view === 'emacs') {
    if (panes.emacs.active) report(editorStatus());
    void panes.emacs.run('/usr/bin/emacs', ['-nw', '--init-directory=/home/user/.config/emacs', notesPath, '--eval', emacsConfig]);
  } else if (view === 'shell') {
    if (panes.shell.active) report(shellStatus);
    void panes.shell.run('/bin/bash', ['-il']);
  } else {
    report('Виртуальная машина работает в браузере.');
  }
}

openEmacs.addEventListener('click', () => selectView('emacs'));
updateControls();

async function run() {
  const imageUrl = new URL('./emacs.erofs', import.meta.url).href;
  const options = {
    worker: true,
    cpus: 1,
    memoryMiB: 512,
    log: (message) => console.debug(message),
    onProgress: ({ stage }) => {
      if (stage === 'compile') bootStage.textContent = 'Браузер компилирует WebAssembly-модуль ядра.';
      if (stage === 'start') bootStage.textContent = 'Ядро запущено. Загружается Alpine Linux.';
    },
    onOutput: captureBoot,
    disks: [{ kind: 'data', name: `emacs-${location.pathname.replace(/index\.html$/, '')}`, template: 'bundled' }],
    onDiskError: (_index, error) => {
      persistent = false;
      machineDisk.textContent = 'Недоступен';
      report('Хранилище браузера недоступно. Скачайте notes.org.', error);
    },
  };

  const wisp = new URLSearchParams(location.search).get('wisp');
  if (wisp) {
    const url = new URL(wisp);
    if (url.protocol !== 'wss:' || url.username || url.password) throw new Error('Укажите адрес Wisp с протоколом wss://.');
    options.net = { kind: 'net', backend: { kind: 'wisp', servers: url.href } };
  }

  try {
    vm = await createKernel({ ...options, distro: imageUrl });
  } catch (error) {
    if (!String(error).includes('does not support Range requests')) throw error;
    bootStage.textContent = 'Скачивается образ Alpine с Emacs.';
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Emacs image: HTTP ${response.status}`);
    fallbackUrl = URL.createObjectURL(await response.blob());
    vm = await createKernel({ ...options, distro: { kind: 'http', url: fallbackUrl } });
  }

  const alpine = await vm.exec('/bin/cat', ['/etc/alpine-release']);
  if (alpine.exitCode !== 0) throw new Error('Не удалось прочитать версию Alpine Linux.');
  const alpineVersion = alpine.stdout.trim();
  document.querySelector('#machine-system').textContent = `Alpine ${alpineVersion}`;
  bootTitle.textContent = 'Alpine Linux готов';
  bootStage.textContent = 'Откройте Doom Emacs или терминал Alpine.';
  persistent &&= vm.disks.find((disk) => disk.index === 0)?.persistent === true;
  machineDisk.textContent = persistent ? 'В браузере' : 'В памяти';
  ready = true;
  showMachineState('ready', 'ВМ запущена');
  restart.hidden = false;
  updateControls();
  report(persistent ? 'Виртуальная машина работает в браузере.' : 'Хранилище браузера недоступно. Скачайте notes.org перед выходом.');

  const ended = await vm.exited;
  if (!shuttingDown) {
    showMachineState('stopped', 'ВМ остановлена');
    report(ended.code === 0 ? 'Виртуальная машина завершила работу.' : `Виртуальная машина остановлена. ${ended.reason}`);
  }
}

async function start() {
  const support = await checkSupport();
  if (!support.ok) {
    showMachineState('stopped', 'Нужен JSPI');
    machineDisk.textContent = 'Не подключён';
    report('Для запуска нужен браузер с WebAssembly JSPI. На iPad откройте страницу в Safari на iPadOS 27 или новее.');
    return;
  }

  async function launch() {
    try {
      await run();
    } catch (error) {
      showMachineState('stopped', 'Ошибка запуска');
      machineDisk.textContent = 'Не подключён';
      report(`Не удалось запустить виртуальную машину. ${error.message}`, error);
    } finally {
      ready = false;
      updateControls();
      if (vm) {
        if (!shuttingDown) await vm.stop();
        vm = undefined;
      }
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
      restart.hidden = false;
    }
  }

  if (navigator.locks) {
    await navigator.locks.request(`unkernel-emacs:${location.pathname.replace(/index\.html$/, '')}`, { ifAvailable: true }, async (lock) => {
      if (lock) await launch();
      else {
        showMachineState('stopped', 'Открыта в другой вкладке');
        machineDisk.textContent = 'Занят';
        report('Emacs уже открыт в другой вкладке. Закройте её и перезапустите сеанс.');
        restart.hidden = false;
      }
    });
  } else {
    await launch();
  }
}

void start().catch((error) => report('Не удалось запустить Emacs.', error));
