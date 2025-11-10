import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fromPath } from "pdf2pic";
import mime from "mime-types"; // ✅ Pour gérer le type MIME des vidéos

dotenv.config();

const app = express();
const API_KEY = process.env.API_KEY;
const FOLDER_ID = process.env.FOLDER_ID;

// Autoriser le front hébergé sur GitHub Pages
app.use(
  cors({
    origin: "https://cyril-cordier.github.io",
  })
);

// --- CONFIGURATION ---
const CACHE_DURATION = 20 * 60 * 1000; // 20 minutes
const TMP_DIR = "/tmp/pdfs";
const FILES_DIR = "/tmp/drive_files";

// Crée les dossiers temporaires si nécessaire
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// Cache en mémoire
let cache = { files: [], timestamp: 0 };

// --- PDF → IMAGE ---
async function convertPdfToImage(pdfPath, fileId) {
  try {
    const options = {
      density: 150,
      saveFilename: fileId,
      savePath: TMP_DIR,
      format: "jpeg",
      width: 1920,
      height: 1080,
    };
    const converter = fromPath(pdfPath, options);
    await converter(1); // Convertit la première page uniquement
    console.log(`✅ PDF converti en image : ${fileId}.jpg`);
    return true;
  } catch (error) {
    console.error(`❌ Erreur conversion PDF ${pdfPath}:`, error);
    return false;
  }
}

// --- RÉCUPÉRATION DES FICHIERS DRIVE ---
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
        // Téléchargement du fichier depuis Google Drive
        const fileRes = await fetch(link);
        const buffer = await fileRes.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(buffer));

        // Conversion PDF → image
        if (file.mimeType === "application/pdf") {
          const success = await convertPdfToImage(filePath, file.id);
          if (success) {
            return {
              ...file,
              mimeType: "image/jpeg",
              webContentLink: `https://${req.get("host")}/pdfs/${file.id}.1.jpg`,
            };
          } else {
            return {
              ...file,
              webContentLink: link,
            };
          }
        }

        // Pour les autres fichiers (images, vidéos, etc.)
        return {
          ...file,
          webContentLink: `https://${req.get("host")}/files/${file.id}`,
        };
      } catch (e) {
        console.error("Erreur téléchargement:", file.name, e);
        return { ...file, webContentLink: link };
      }
    })
  );

  cache = { files, timestamp: Date.now() };
  return files;
}

// --- ROUTES STATIC PDF/IMAGES ---
app.use("/pdfs", express.static(TMP_DIR));

// --- STREAMING VIDÉO & SERVEUR DE FICHIERS ---
app.get("/files/:id", (req, res) => {
  const filePath = path.join(FILES_DIR, req.params.id);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Fichier introuvable");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const mimeType = mime.lookup(filePath) || "application/octet-stream";

  // Si le client demande un Range (streaming)
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });

    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": mimeType,
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    // Lecture complète (pour les images, PDF convertis…)
    const head = {
      "Content-Length": fileSize,
      "Content-Type": mimeType,
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// --- ROUTE PRINCIPALE : LISTE DES FICHIERS ---
app.get("/files", async (req, res) => {
  try {
    // Si cache encore valide
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

// --- ROUTE DE RAFRAÎCHISSEMENT MANUEL ---
app.get("/refresh", async (req, res) => {
  cache = { files: [], timestamp: 0 };
  const files = await fetchDriveFiles(req);
  res.json({ files });
});

// --- NETTOYAGE DES FICHIERS TEMPORAIRES ---
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

// Nettoyage toutes les heures
setInterval(() => cleanupOldFiles(FILES_DIR), 60 * 60 * 1000);
setInterval(() => cleanupOldFiles(TMP_DIR), 60 * 60 * 1000);

// --- DÉMARRAGE SERVEUR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur port ${PORT}`));
