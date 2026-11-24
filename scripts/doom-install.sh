community=https://dl-cdn.alpinelinux.org/alpine/v$(cut -d. -f1,2 /etc/alpine-release)/community
doom_revision=8b9b1ea14d02c6f18114a8e183469f685e0fa34e

apk add --no-cache --repository "$community" erofs-utils
mkdir -p /tmp/base /tmp/root
mount -t erofs -o ro /dev/wda /tmp/base
cp -a /tmp/base/. /tmp/root/
apk --root /tmp/root add --no-cache --repository "$community" \
  emacs-nox ncurses-terminfo-base ca-certificates bash git ripgrep fd
echo "$community" >> /tmp/root/etc/apk/repositories

mkdir -p /tmp/root/home/user/.config/doom /tmp/root/etc/profile.d
cat > /tmp/root/home/user/.config/doom/init.el <<'EOF'
;;; init.el -*- lexical-binding: t; -*-
(doom!
 :ui doom
 :editor evil)
EOF
cat > /tmp/root/home/user/.config/doom/config.el <<'EOF'
;;; config.el -*- lexical-binding: t; -*-
(setq doom-theme 'doom-one)
EOF
cat > /tmp/root/etc/profile.d/doom.sh <<'EOF'
if [ -d "$HOME/.config/emacs/bin" ]; then
  export PATH="$HOME/.config/emacs/bin:$PATH"
fi
EOF
chown -R 1000:1000 /tmp/root/home/user/.config

mount --bind /dev /tmp/root/dev
mount --bind /proc /tmp/root/proc
if [ -e /tmp/root/etc/resolv.conf ] || [ -L /tmp/root/etc/resolv.conf ]; then
  mv /tmp/root/etc/resolv.conf /tmp/build-resolv.conf
fi
cp -L /etc/resolv.conf /tmp/root/etc/resolv.conf

chroot /tmp/root /bin/su user -s /bin/sh -c "
  set -e
  export LANG=C.UTF-8 TERM=xterm-256color GIT_TERMINAL_PROMPT=0
  cd /home/user/.config
  git init -q emacs
  git -C emacs remote add origin https://github.com/doomemacs/core.git
  git -C emacs fetch --depth 1 origin $doom_revision
  git -C emacs checkout --detach FETCH_HEAD
  git -C emacs submodule update --init --depth 1
  emacs/bin/doom -! sync
"

rm /tmp/root/etc/resolv.conf
if [ -e /tmp/build-resolv.conf ] || [ -L /tmp/build-resolv.conf ]; then
  mv /tmp/build-resolv.conf /tmp/root/etc/resolv.conf
fi
umount /tmp/root/proc
umount /tmp/root/dev
mkfs.erofs --quiet -L kwroot /tmp/emacs.erofs /tmp/root
