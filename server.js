import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fromPath } from "pdf2pic";

dotenv.config();

const app = express();
const API_KEY = process.env.API_KEY;
const FOLDER_ID = process.env.FOLDER_ID;

app.use(
  cors({
    origin: "https://cyril-cordier.github.io",
  })
);

// Cache pour les fichiers
const CACHE_DURATION = 20 * 60 * 1000; // 20 minutes
let cache = { files: [], timestamp: 0 };

// Répertoires pour stocker les fichiers
const TMP_DIR = "/tmp/pdfs";
const FILES_DIR = "/tmp/drive_files";

// Création des répertoires s'ils n'existent pas
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// Fonction pour récupérer et traiter les fichiers
async function fetchDriveFiles(req) {
  console.log("🔄 Fetch depuis Google Drive...");
  const driveUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    `'${FOLDER_ID}' in parents and trashed = false`
  )}&fields=files(id,name,mimeType,modifiedTime)&key=${API_KEY}`;
  const res = await fetch(driveUrl);
  const data = await res.json();
  if (!data.files) throw new Error("Erreur Drive API");

  const files = await Promise.all(
    data.files.map(async (file) => {
      const link = `https://drive.google.com/uc?id=${file.id}&export=download`;
      const filePath = path.join(FILES_DIR, file.id);

      try {
        // Télécharger le fichier
        const fileRes = await fetch(link);
        const buffer = await fileRes.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(buffer));

        // Pour les PDFs : conversion en image
        if (file.mimeType === "application/pdf") {
          const imgPath = path.join(TMP_DIR, `${file.id}.jpg`);
          const converter = fromPath(filePath, {
            density: 150,
            saveFilename: file.id,
            savePath: TMP_DIR,
            format: "jpeg",
            width: 1920,
            height: 1080,
          });
          await converter(1);
          return {
            ...file,
            mimeType: "image/jpeg",
            webContentLink: `${req.protocol}://${req.get("host")}/pdfs/${file.id}.1.jpg`,
          };
        }
        // Pour les autres fichiers : servir directement
        else {
          return {
            ...file,
            webContentLink: `${req.protocol}://${req.get("host")}/files/${file.id}`,
          };
        }
      } catch (e) {
        console.error("Erreur téléchargement:", file.name, e);
        return { ...file, webContentLink: link }; // Retourne l'URL directe en cas d'erreur
      }
    })
  );

  cache = { files, timestamp: Date.now() };
  return files;
}

// Routes pour servir les fichiers
app.use("/pdfs", express.static(TMP_DIR));
app.use("/files", express.static(FILES_DIR));

// Route pour récupérer les fichiers
app.get("/files", async (req, res) => {
  try {
    if (Date.now() - cache.timestamp < CACHE_DURATION && cache.files.length > 0) {
      console.log("⚡ Renvoi depuis cache");
      return res.json({ files: cache.files });
    }
    const files = await fetchDriveFiles(req);
    res.json({ files });
  } catch (err) {
    console.error("Erreur serveur:", err);
    res.status(500).json({ error: "Erreur lors de la récupération des fichiers" });
  }
});

// Route pour forcer le rafraîchissement du cache
app.get("/refresh", async (req, res) => {
  cache = { files: [], timestamp: 0 };
  const files = await fetchDriveFiles(req);
  res.json({ files });
});

// Nettoyage des fichiers anciens
function cleanupOldFiles(dir, maxAgeMs = 24 * 60 * 60 * 1000) {
  fs.readdir(dir, (err, files) => {
    if (err) return console.error("Erreur lecture répertoire:", err);
    files.forEach((file) => {
      const filePath = path.join(dir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return console.error("Erreur stat fichier:", err);
        if (Date.now() - stats.mtimeMs > maxAgeMs) {
          fs.unlink(filePath, (err) => {
            if (err) console.error("Erreur suppression:", err);
            else console.log(`Supprimé : ${filePath}`);
          });
        }
      });
    });
  });
}

// Nettoyage automatique toutes les heures
setInterval(() => cleanupOldFiles(FILES_DIR), 60 * 60 * 1000);
setInterval(() => cleanupOldFiles(TMP_DIR), 60 * 60 * 1000);

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur port ${PORT}`));
