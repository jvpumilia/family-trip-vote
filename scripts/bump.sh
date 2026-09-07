#!/bin/zsh
# Stamp the script/stylesheet links so browsers and the GitHub Pages cache pick up every release.
cd "$(dirname "$0")/.."
v=$(date +%Y%m%d%H%M%S)
sed -i '' -E "s#(app\.js|style\.css|config\.js)(\?v=[0-9]+)?\"#\1?v=$v\"#g" docs/index.html
grep -o 'app.js?v=[0-9]*' docs/index.html
