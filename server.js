import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";

// pdf2pic nécessite GraphicsMagick, on l'importe dynamiquement si disponible
let pdf2picModule = null;

// node-poppler nécessite les binaires Poppler, on l'initialise conditionnellement
let poppler = null;
try {
  const { Poppler } = await import("node-poppler");
  
  // Fonction pour vérifier si pdftocairo existe
  const checkPdfToCairo = (dir) => {
    const pdftocairoPath = path.join(dir, "pdftocairo");
    return fs.existsSync(pdftocairoPath);
  };
  
  // Sur macOS, essayer de trouver poppler via Homebrew
  if (os.platform() === "darwin") {
    const brewPath = "/opt/homebrew/bin"; // Homebrew sur Apple Silicon
    const brewPathIntel = "/usr/local/bin"; // Homebrew sur Intel
    
    if (checkPdfToCairo(brewPath)) {
      poppler = new Poppler(brewPath);
    } else if (checkPdfToCairo(brewPathIntel)) {
      poppler = new Poppler(brewPathIntel);
    } else {
      // Essayer sans chemin spécifique (peut-être dans PATH)
      try {
        poppler = new Poppler();
      } catch {
        console.warn("⚠️ Poppler non trouvé sur macOS. Pour l'installer: brew install poppler");
      }
    }
  } else {
    // Sur Linux, node-poppler devrait trouver les binaires automatiquement
    try {
      poppler = new Poppler();
    } catch (error) {
      console.warn("⚠️ Poppler non trouvé sur Linux. Installation requise: apt-get install poppler-utils");
    }
  }
} catch (error) {
  console.warn("⚠️ node-poppler non disponible:", error.message);
}

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

// Fonction pour obtenir l'extension depuis le mimeType
function getExtensionFromMimeType(mimeType) {
  const mimeToExt = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/plain": "txt",
    "text/html": "html",
    "application/json": "json",
  };
  return mimeToExt[mimeType] || "bin";
}

// Fonction pour convertir un PDF en image
async function convertPdfToImage(pdfPath, fileId) {
  // Essayer d'abord pdf2pic si GraphicsMagick est disponible
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
    console.log(`✅ PDF converti en image (pdf2pic) : ${fileId}.1.jpg`);
    return true;
  } catch (error) {
    console.warn(`⚠️ pdf2pic non disponible, tentative avec node-poppler :`, error.message);
    // Fallback vers node-poppler (fonctionne sur Linux, nécessite poppler-utils)
    if (!poppler) {
      console.error(`❌ node-poppler non disponible. Installation requise: brew install poppler (macOS) ou apt-get install poppler-utils (Linux)`);
      return false;
    }
    try {
      // node-poppler peut créer le fichier avec différents noms selon la configuration
      // On utilise un préfixe de base et on cherche le fichier créé après
      const outputBase = path.join(TMP_DIR, fileId);
      const expectedPath = path.join(TMP_DIR, `${fileId}.1.jpg`);
      
      // Lister les fichiers avant la conversion
      const filesBefore = fs.existsSync(TMP_DIR) ? fs.readdirSync(TMP_DIR) : [];
      
      await poppler.pdfToCairo(pdfPath, outputBase, {
        jpegFile: true,
        firstPageToConvert: 1,
        lastPageToConvert: 1,
        resolutionXYAxis: 150,
        scalePageTo: 1920, // Redimensionne le côté long à 1920px
      });
      
      // Attendre un peu pour que le fichier soit écrit
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Lister les fichiers après la conversion
      const filesAfter = fs.readdirSync(TMP_DIR);
      const newFiles = filesAfter.filter(f => !filesBefore.includes(f));
      
      // Chercher le fichier créé (peut être .jpg, .jpeg, -1.jpg, -1.jpeg, etc.)
      const createdFile = newFiles.find(f => 
        f.startsWith(fileId) && (f.endsWith('.jpg') || f.endsWith('.jpeg'))
      );
      
      if (createdFile) {
        const createdPath = path.join(TMP_DIR, createdFile);
        // Si le nom n'est pas celui attendu, on le renomme
        if (createdFile !== `${fileId}.1.jpg`) {
          fs.renameSync(createdPath, expectedPath);
          console.log(`✅ PDF converti en image (node-poppler) : ${fileId}.1.jpg (renommé depuis ${createdFile})`);
        } else {
          console.log(`✅ PDF converti en image (node-poppler) : ${fileId}.1.jpg`);
        }
        return true;
      } else if (fs.existsSync(expectedPath)) {
        // Le fichier existe déjà avec le bon nom
        console.log(`✅ PDF converti en image (node-poppler) : ${fileId}.1.jpg`);
        return true;
      } else {
        // Chercher tous les fichiers JPEG qui commencent par fileId
        const allJpegs = filesAfter.filter(f => 
          f.startsWith(fileId) && (f.endsWith('.jpg') || f.endsWith('.jpeg'))
        );
        if (allJpegs.length > 0) {
          const foundFile = allJpegs[0];
          const foundPath = path.join(TMP_DIR, foundFile);
          fs.renameSync(foundPath, expectedPath);
          console.log(`✅ PDF converti en image (node-poppler) : ${fileId}.1.jpg (renommé depuis ${foundFile})`);
          return true;
        }
        console.error(`❌ Fichier image non trouvé après conversion. Fichiers créés: ${newFiles.join(', ') || 'aucun'}`);
        return false;
      }
    } catch (error2) {
      console.error(`❌ Erreur conversion PDF ${pdfPath}:`, error2);
      return false;
    }
  }
}

// Fonction pour télécharger un fichier Google Drive (en suivant les redirections)
async function downloadFromDrive(link, destPath) {
  try {
    // Première requête : peut rediriger
    const initialRes = await fetch(link, { redirect: "manual" });
    let downloadUrl = link;

    if (initialRes.status === 302 || initialRes.status === 301) {
      const location = initialRes.headers.get("location");
      if (location) downloadUrl = location;
    }

    // Deuxième requête : vrai téléchargement
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) throw new Error(`Erreur HTTP ${fileRes.status}`);

    const buffer = await fileRes.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buffer));
    return true;
  } catch (err) {
    console.error("❌ Erreur lors du téléchargement Google Drive:", err);
    return false;
  }
}

// Fonction pour obtenir le protocole (http en local, https en production)
function getProtocol(req) {
  // En production (Render, Heroku, etc.), utiliser https
  // Détecter via l'en-tête X-Forwarded-Proto ou l'environnement
  if (process.env.NODE_ENV === "production" || req.get("x-forwarded-proto") === "https") {
    return "https";
  }
  // En local, utiliser http
  return "http";
}

// Fonction pour récupérer et traiter les fichiers
async function fetchDriveFiles(req) {
  console.log("🔄 Fetch depuis Google Drive...");
  const driveUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    `'${FOLDER_ID}' in parents and trashed = false`
  )}&fields=files(id,name,mimeType,modifiedTime)&key=${API_KEY}`;
  const res = await fetch(driveUrl);
  const data = await res.json();
  if (!data.files) throw new Error("Erreur Drive API");
  
  const protocol = getProtocol(req);

  const files = await Promise.all(
    data.files.map(async (file) => {
      const link = `https://drive.google.com/uc?id=${file.id}&export=download`;
      const extension = getExtensionFromMimeType(file.mimeType);
      const fileName = `${file.id}.${extension}`;
      const filePath = path.join(FILES_DIR, fileName);
      try {
        // 🔁 Téléchargement (avec suivi de redirection)
        const success = await downloadFromDrive(link, filePath);

        if (!success) {
          console.warn(`⚠️ Fichier non téléchargé : ${file.name}`);
          return { ...file, webContentLink: link };
        }

        console.log(`✅ Téléchargé : ${file.name} (${file.mimeType})`);

        // PDF → image
        if (file.mimeType === "application/pdf") {
          const converted = await convertPdfToImage(filePath, file.id);
          if (converted) {
            return {
              ...file,
              mimeType: "image/jpeg",
              webContentLink: `${protocol}://${req.get("host")}/pdfs/${file.id}.1.jpg`,
            };
          } else {
            // Si la conversion échoue, retourner le PDF original depuis Google Drive
            console.warn(`⚠️ Conversion PDF échouée pour ${file.name}, utilisation du PDF original`);
            return {
              ...file,
              webContentLink: link,
            };
          }
        }

        // Tout le reste → fichier local avec extension
        return {
          ...file,
          webContentLink: `${protocol}://${req.get("host")}/files/${fileName}`,
        };
      } catch (e) {
        console.error("Erreur traitement:", file.name, e);
        return { ...file, webContentLink: link };
      }
    })
  );

  cache = { files, timestamp: Date.now() };
  return files;
}

// Routes pour servir les fichiers
app.use("/pdfs", express.static(TMP_DIR));

// Route principale pour la liste des fichiers (doit être AVANT le middleware static)
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

// Forcer le rafraîchissement manuel
app.get("/refresh", async (req, res) => {
  cache = { files: [], timestamp: 0 };
  const files = await fetchDriveFiles(req);
  res.json({ files });
});

// Gérer les requêtes OPTIONS (preflight CORS) pour les vidéos
app.options("/files/*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  res.setHeader("Access-Control-Max-Age", "86400"); // 24 heures
  res.sendStatus(204);
});

// Route pour servir les fichiers avec le bon Content-Type (après les routes GET)
app.use("/files", (req, res, next) => {
  // Ignorer si c'est une requête pour la liste (déjà gérée par la route GET)
  if (req.path === "" || req.path === "/") {
    return next();
  }
  
  const filePath = path.join(FILES_DIR, req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".html": "text/html",
      ".json": "application/json",
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    
    // Pour les vidéos, permettre le streaming (Range requests)
    if (contentType.startsWith("video/")) {
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      // Headers CORS pour les vidéos
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Range");
      res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        
        // Validation des valeurs
        if (isNaN(start) || isNaN(end) || start < 0 || end >= fileSize || start > end) {
          res.setHeader("Content-Range", `bytes */${fileSize}`);
          res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
          return res.end();
        }
        
        const chunksize = end - start + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize,
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
        };
        res.writeHead(206, head);
        file.pipe(res);
        return;
      } else {
        // Pas de Range header : renvoyer le fichier complet mais en streaming
        // Le navigateur utilisera le streaming grâce à Accept-Ranges
        res.setHeader("Content-Length", fileSize);
        res.setHeader("Accept-Ranges", "bytes");
        // Laisser express.static gérer le streaming du fichier complet
        // Le navigateur fera ensuite des requêtes Range pour les chunks nécessaires
      }
    }
  }
  next();
}, express.static(FILES_DIR));

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
