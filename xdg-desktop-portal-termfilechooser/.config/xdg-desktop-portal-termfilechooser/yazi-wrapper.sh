#!/bin/bash

# This wrapper script is invoked by xdg-desktop-portal-termfilechooser
# Arguments:
#   $1: "1" for save mode, "0" for open mode
#   $2: Starting directory (if provided)
#   $3: Default filename (only for save mode)

# File to write selection to (provided by portal)
output_file="$1"
shift

save_mode="$1"
shift

# Starting directory
if [ -n "$1" ]; then
    start_dir="$1"
else
    start_dir="$HOME"
fi

# For save mode, get default filename
if [ "$save_mode" = "1" ] && [ -n "$2" ]; then
    default_name="$2"
fi

# Launch yazi in a floating terminal with a specific class for window rules
# Using foot as terminal - adjust if you use a different terminal
if command -v ghostty &> /dev/null; then
    ghostty --class=yazi-selector -e yazi --chooser-file="$output_file" "$start_dir"
elif command -v foot &> /dev/null; then
    foot --app-id=yazi-selector yazi --chooser-file="$output_file" "$start_dir"
elif command -v kitty &> /dev/null; then
    kitty --class=yazi-selector yazi --chooser-file="$output_file" "$start_dir"
elif command -v alacritty &> /dev/null; then
    alacritty --class yazi-selector -e yazi --chooser-file="$output_file" "$start_dir"
else
    # Fallback
    xterm -class yazi-selector -e yazi --chooser-file="$output_file" "$start_dir"
fi
