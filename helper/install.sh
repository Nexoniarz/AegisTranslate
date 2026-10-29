#!/bin/sh
# Installs the AegisTranslate local helper for Firefox on Linux or macOS.
#   ./install.sh               install for the current user
#   ./install.sh --uninstall   remove it again
# NixOS users: see helper/default.nix instead.
set -eu

NAME=aegistranslate_helper
HERE=$(cd "$(dirname "$0")" && pwd)
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/aegistranslate"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/aegistranslate"
case "$(uname -s)" in
  Darwin) HOSTS="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  *)      HOSTS="$HOME/.mozilla/native-messaging-hosts" ;;
esac

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$HOSTS/$NAME.json"
  rm -rf "$DATA"
  echo "Removed. Settings in $CONFIG_DIR and models in ~/.cache/llama.cpp were kept."
  exit 0
fi

PYTHON=$(command -v python3 || true)
if [ -z "$PYTHON" ]; then
  echo "python3 is required but was not found." >&2
  exit 1
fi

LLAMA=${LLAMA_SERVER:-$(command -v llama-server || true)}
if [ -z "$LLAMA" ]; then
  cat >&2 <<'MSG'
llama-server (from llama.cpp) was not found. Install a GPU build first, for example:
  Arch:          yay -S llama.cpp-cuda      (or llama.cpp-vulkan)
  macOS:         brew install llama.cpp
  Other Linux:   download a Vulkan build from https://github.com/ggml-org/llama.cpp/releases
Then run this script again, or pass the path: LLAMA_SERVER=/path/to/llama-server ./install.sh
MSG
  exit 1
fi

mkdir -p "$DATA" "$HOSTS" "$CONFIG_DIR"
cp "$HERE/aegistranslate_helper.py" "$DATA/"
cat > "$DATA/aegistranslate-helper" <<SH
#!/bin/sh
exec "$PYTHON" "$DATA/aegistranslate_helper.py" "\$@"
SH
chmod +x "$DATA/aegistranslate-helper"

if [ ! -f "$CONFIG_DIR/helper.json" ]; then
  printf '{\n  "llama_server": "%s",\n  "device": null\n}\n' "$LLAMA" > "$CONFIG_DIR/helper.json"
fi

cat > "$HOSTS/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "AegisTranslate local helper (llama.cpp)",
  "path": "$DATA/aegistranslate-helper",
  "type": "stdio",
  "allowed_extensions": ["aegistranslate@nexoniarz"]
}
JSON

echo "Installed. Checking which GPU it will use:"
AEGIS_LLAMA_SERVER="$LLAMA" "$DATA/aegistranslate-helper" --check || true
echo
echo "Now open the AegisTranslate popup and choose Engine: Local helper."
