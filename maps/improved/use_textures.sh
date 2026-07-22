#!/bin/sh
# Toggle between original and HD textures for all maps.
# usage: ./use_textures.sh hd|original
case "$1" in
  hd)       sed -i 's|map_Kd textures/|map_Kd textures_hd/|' *.mtl ;;
  original) sed -i 's|map_Kd textures_hd/|map_Kd textures/|' *.mtl ;;
  *) echo "usage: $0 hd|original"; exit 1 ;;
esac
echo "now using: $1"
