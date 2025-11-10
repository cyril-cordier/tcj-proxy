import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import pdfPoppler from "pdf-poppler";

dotenv.config();
const app = express();

const API_KEY = process.env.API_KEY;
const FOLDER_ID = process.env.FOLDER_ID;

app.use(
  cors({
    origin: "https://cyril-cordier.github.io", // ton site GitHub Pages
  })
);

const CACHE_DURATION = 20 * 60 * 1000; // 20 minutes
let cache = { files: [], timestamp: 0 };

const TMP_DIR = "/tmp/pdfs"; // dossier temporaire Render
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

async function fetchDriveFiles() {
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

      if (file.mimeType === "application/pdf") {
        try {
          const pdfPath = path.join(TMP_DIR, `${file.id}.pdf`);
          const imgPath = path.join(TMP_DIR, `${file.id}.jpg`);

          // Télécharger le PDF
          const pdfRes = await fetch(link);
          const buffer = await pdfRes.arrayBuffer();
          fs.writeFileSync(pdfPath, Buffer.from(buffer));

          // Convertir PDF → image
          await pdfPoppler.convert(pdfPath, {
            format: "jpeg",
            out_dir: TMP_DIR,
            out_prefix: file.id,
            page: 1,
          });

          return {
            ...file,
            mimeType: "image/jpeg",
            webContentLink: `${req.protocol}://${req.get("host")}/pdfs/${file.id}-1.jpg`,
          };
        } catch (e) {
          console.error("Erreur conversion PDF:", file.name, e);
        }
      }

      return {
        ...file,
        webContentLink: link,
      };
    })
  );

  cache = { files, timestamp: Date.now() };
  return files;
}

// Route fichiers PDF convertis
app.use("/pdfs", express.static(TMP_DIR));

// Route principale
app.get("/files", async (req, res) => {
  try {
    // Si cache < 20 min → utiliser cache
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur port ${PORT}`));
