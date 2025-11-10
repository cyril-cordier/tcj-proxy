#!/bin/bash
# Script de pré-installation pour Render (Linux)
# Installe GraphicsMagick uniquement sur les systèmes Linux

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  echo "Installation de GraphicsMagick pour Linux (Render)..."
  sudo apt-get update
  sudo apt-get install -y graphicsmagick
  echo "GraphicsMagick installé avec succès."
elif [[ "$OSTYPE" == "darwin"* ]]; then
  echo "macOS détecté. Pour installer GraphicsMagick localement, utilisez: brew install graphicsmagick"
  echo "Le script continue sans erreur pour permettre le développement local."
else
  echo "OS non reconnu: $OSTYPE. Le script continue sans erreur."
fi

