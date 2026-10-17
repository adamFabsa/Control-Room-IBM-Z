#!/usr/bin/env bash
# Run once on the LinuxONE VM: download Granite 3.3 2B Instruct and convert it to a
# big-endian GGUF, since s390x is big-endian and published GGUF files are little-endian.
set -euo pipefail
LLAMA_CPP_TAG=b11267
# Q8_0: Q4_K_M was about as fast here but invented numbers in testing.
MODEL=granite-3.3-2b-instruct-Q8_0
MODELS_DIR=${MODELS_DIR:-$HOME/models}
SRC_DIR=${SRC_DIR:-$HOME/src/llama.cpp}

sudo apt-get install -y -qq python3-numpy python3-tqdm python3-yaml >/dev/null
[ -d "$SRC_DIR" ] || git clone -q --depth 1 --branch "$LLAMA_CPP_TAG" https://github.com/ggml-org/llama.cpp "$SRC_DIR"

mkdir -p "$MODELS_DIR" && cd "$MODELS_DIR"
[ -s "$MODEL.gguf" ] || curl -sSL --fail -o "$MODEL.gguf" \
  "https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF/resolve/main/$MODEL.gguf"

# The converter rewrites the file in place, so convert a copy; it asks for a typed YES.
cp "$MODEL.gguf" granite-3.3-2b-instruct-q8-be.gguf.tmp
echo YES | PYTHONPATH="$SRC_DIR/gguf-py" python3 "$SRC_DIR/gguf-py/gguf/scripts/gguf_convert_endian.py" \
  granite-3.3-2b-instruct-q8-be.gguf.tmp big
mv granite-3.3-2b-instruct-q8-be.gguf.tmp granite-3.3-2b-instruct-q8-be.gguf
ls -la "$MODELS_DIR"
