import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import pdfPoppler from "pdf-poppler";

// pdf2pic ne supporte pas Linux, on l'importe dynamiquement si nécessaire
let pdf2picModule = null;
const isLinux = os.platform() === "linux";

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

// Fonction pour convertir un PDF en image (avec fallback)
async function convertPdfToImage(pdfPath, fileId) {
  // Sur Linux, utiliser directement pdf-poppler (pdf2pic ne supporte pas Linux)
  if (isLinux) {
    try {
      const outputDir = TMP_DIR;
      const outputPath = path.join(outputDir, `${fileId}.1.jpg`);
      await pdfPoppler.convert(pdfPath, {
        outDir: outputDir,
        outPrefix: fileId,
        format: "jpeg",
        page: 1,
      });
      // pdf-poppler crée le fichier avec un nom différent, on le renomme si nécessaire
      const files = fs.readdirSync(TMP_DIR);
      const jpgFile = files.find(f => f.startsWith(fileId) && f.endsWith('.jpg'));
      if (jpgFile && jpgFile !== `${fileId}.1.jpg`) {
        const oldPath = path.join(TMP_DIR, jpgFile);
        const newPath = path.join(TMP_DIR, `${fileId}.1.jpg`);
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        }
      }
      console.log(`✅ PDF converti en image (pdf-poppler) : ${path.join(TMP_DIR, `${fileId}.1.jpg`)}`);
      return true;
    } catch (error) {
      console.error(`❌ Erreur conversion PDF (pdf-poppler) :`, error);
      return false;
    }
  }

  // Sur macOS/Windows, essayer d'abord pdf2pic
  try {
    if (!pdf2picModule) {
      pdf2picModule = await import("pdf2pic");
    }
    const options = {
      density: 150,
      saveFilename: fileId,
      savePath: TMP_DIR,
      format: "jpeg",
      width: 1920,
      height: 1080,
    };
    const converter = pdf2picModule.fromPath(pdfPath, options);
    await converter(1);
    console.log(`✅ PDF converti en image (pdf2pic) : ${TMP_DIR}/${fileId}.1.jpg`);
    return true;
  } catch (error) {
    console.error(`❌ Erreur avec pdf2pic, tentative avec pdf-poppler :`, error);
    try {
      // Fallback vers pdf-poppler
      const outputDir = TMP_DIR;
      await pdfPoppler.convert(pdfPath, {
        outDir: outputDir,
        outPrefix: fileId,
        format: "jpeg",
        page: 1,
      });
      // Renommer le fichier si nécessaire
      const files = fs.readdirSync(TMP_DIR);
      const jpgFile = files.find(f => f.startsWith(fileId) && f.endsWith('.jpg'));
      if (jpgFile && jpgFile !== `${fileId}.1.jpg`) {
        const oldPath = path.join(TMP_DIR, jpgFile);
        const newPath = path.join(TMP_DIR, `${fileId}.1.jpg`);
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        }
      }
      console.log(`✅ PDF converti en image (pdf-poppler) : ${path.join(TMP_DIR, `${fileId}.1.jpg`)}`);
      return true;
    } catch (error) {
      console.error(`❌ Erreur conversion PDF (pdf-poppler) :`, error);
      return false;
    }
  }
}

// Fonction pour récupérer et traiter les fichiers
async function fetchDriveFiles(req) {
  console.log("🔄 Fetch depuis Google Drive...");
  if (!API_KEY || !FOLDER_ID) {
    throw new Error("API_KEY ou FOLDER_ID manquant dans les variables d'environnement");
  }
  const driveUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    `'${FOLDER_ID}' in parents and trashed = false`
  )}&fields=files(id,name,mimeType,modifiedTime)&key=${API_KEY}`;
  const res = await fetch(driveUrl);
  const data = await res.json();
  if (!res.ok) {
    console.error("Erreur API Drive:", data);
    throw new Error(`Erreur Drive API: ${data.error?.message || res.statusText}`);
  }
  if (!data.files) {
    console.error("Réponse API Drive invalide:", data);
    throw new Error("Erreur Drive API: réponse invalide");
  }

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
          const success = await convertPdfToImage(filePath, file.id);
          if (success) {
            const imagePath = path.join(TMP_DIR, `${file.id}.1.jpg`);
            if (fs.existsSync(imagePath)) {
              return {
                ...file,
                mimeType: "image/jpeg",
                webContentLink: `https://${req.get("host")}/pdfs/${file.id}.1.jpg`,
              };
            }
          }
          // Fallback vers l'URL directe du PDF
          console.warn(`⚠️ Conversion échouée pour ${file.name}, utilisation du PDF direct`);
          return {
            ...file,
            webContentLink: link,
          };
        }
        // Pour les autres fichiers
        else {
          return {
            ...file,
            webContentLink: `https://${req.get("host")}/files/${file.id}`,
          };
        }
      } catch (e) {
        console.error("Erreur téléchargement:", file.name, e);
        return { ...file, webContentLink: link };
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
            else console.log(`🗑️ Supprimé : ${filePath}`);
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
