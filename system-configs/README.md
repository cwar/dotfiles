# System Configs

System-level configs that require sudo to install (can't be managed by stow).

## Contents

### SDDM (Login Screen)
- `theme.conf` → `/etc/sddm.conf.d/theme.conf` - Sets elarun as the theme
- `sddm-theme.conf` → `/etc/sddm.conf.d/sddm-theme.conf`
- `metadata.desktop` - Theme metadata

### Plymouth (Boot Animation)
- `crash-override.plymouth` → `/usr/share/plymouth/themes/crash-override/`
- `crash-override.script` → `/usr/share/plymouth/themes/crash-override/`
- `frames.tar.gz` - 100 animation frames

### Autofs (NFS auto-mounting)
- `nfs.autofs` → `/etc/autofs/auto.master.d/nfs.autofs` - Master map entry
- `auto.nfs` → `/etc/autofs/auto.nfs` - NFS share mappings for cwarstorage

## Install

```bash
cd ~/dotfiles/system-configs && sudo ./install.sh
```
