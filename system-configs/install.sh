#!/bin/bash
# Install system configs that require sudo
# Run: sudo ./install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing SDDM configs..."
mkdir -p /etc/sddm.conf.d
cp "$SCRIPT_DIR/sddm/theme.conf" /etc/sddm.conf.d/
cp "$SCRIPT_DIR/sddm/sddm-theme.conf" /etc/sddm.conf.d/

echo "Installing Plymouth theme..."
mkdir -p /usr/share/plymouth/themes/crash-override
cp "$SCRIPT_DIR/plymouth/crash-override.plymouth" /usr/share/plymouth/themes/crash-override/
cp "$SCRIPT_DIR/plymouth/crash-override.script" /usr/share/plymouth/themes/crash-override/

echo "Extracting Plymouth frames..."
tar -xzf "$SCRIPT_DIR/plymouth/frames.tar.gz" -C /usr/share/plymouth/themes/crash-override/

echo "Setting Plymouth theme..."
plymouth-set-default-theme -R crash-override

echo "Installing autofs configs..."
mkdir -p /etc/autofs/auto.master.d
cp "$SCRIPT_DIR/autofs/nfs.autofs" /etc/autofs/auto.master.d/
cp "$SCRIPT_DIR/autofs/auto.nfs" /etc/autofs/
systemctl enable --now autofs

echo "Done!"
