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

const CACHE_DURATION = 20 * 60 * 1000; // 20 minutes
let cache = { files: [], timestamp: 0 };

const TMP_DIR = "/tmp/pdfs";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

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

      if (file.mimeType === "application/pdf") {
        try {
          const pdfPath = path.join(TMP_DIR, `${file.id}.pdf`);
          const imgPath = path.join(TMP_DIR, `${file.id}.jpg`);

          // Téléchargement PDF
          const pdfRes = await fetch(link);
          const buffer = await pdfRes.arrayBuffer();
          fs.writeFileSync(pdfPath, Buffer.from(buffer));

          // Conversion PDF → image via pdf2pic
          const converter = fromPath(pdfPath, {
            density: 150,
            saveFilename: file.id,
            savePath: TMP_DIR,
            format: "jpeg",
            width: 1920,
            height: 1080,
          });

          await converter(1); // première page

          return {
            ...file,
            mimeType: "image/jpeg",
            webContentLink: `${req.protocol}://${req.get("host")}/pdfs/${file.id}.1.jpg`,
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

app.use("/pdfs", express.static(TMP_DIR));

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

app.get("/refresh", async (req, res) => {
  cache = { files: [], timestamp: 0 };
  const files = await fetchDriveFiles(req);
  res.json({ files });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur port ${PORT}`));
