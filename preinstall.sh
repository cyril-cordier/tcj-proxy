#!/bin/bash
# Script de pré-installation pour Render (Linux)
# Installe poppler-utils pour node-poppler

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  echo "Installation de poppler-utils et poppler-data pour Linux (Render)..."
  sudo apt-get update
  sudo apt-get install -y poppler-utils poppler-data
  echo "poppler-utils et poppler-data installés avec succès."
elif [[ "$OSTYPE" == "darwin"* ]]; then
  echo "macOS détecté. Pour installer poppler-utils localement, utilisez: brew install poppler"
  echo "Le script continue sans erreur pour permettre le développement local."
else
  echo "OS non reconnu: $OSTYPE. Le script continue sans erreur."
fi

