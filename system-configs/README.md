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

## Install

```bash
cd ~/dotfiles/system-configs && sudo ./install.sh
```
