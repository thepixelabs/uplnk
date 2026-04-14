import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import unzipper from 'unzipper';

const MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const MODEL_DIR = path.join(os.homedir(), '.uplnk', 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'vosk-model-small-en-us');

export async function ensureModelExists(onProgress?: (msg: string) => void): Promise<string> {
  if (fs.existsSync(MODEL_PATH)) {
    return MODEL_PATH;
  }

  if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true });
  }

  onProgress?.('Downloading Vosk model (English small)...');

  return new Promise((resolve, reject) => {
    https.get(MODEL_URL, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download model: ${response.statusCode}`));
        return;
      }

      const tempZip = path.join(MODEL_DIR, 'model.zip');
      const file = fs.createWriteStream(tempZip);
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        onProgress?.('Extracting model...');
        fs.createReadStream(tempZip)
          .pipe(unzipper.Extract({ path: MODEL_DIR }))
          .on('close', () => {
            fs.unlinkSync(tempZip);
            // The zip extracts to a folder with a version suffix, rename it
            const extractedDir = path.join(MODEL_DIR, 'vosk-model-small-en-us-0.15');
            if (fs.existsSync(extractedDir)) {
              fs.renameSync(extractedDir, MODEL_PATH);
            }
            onProgress?.('Model ready.');
            resolve(MODEL_PATH);
          })
          .on('error', reject);
      });
    }).on('error', reject);
  });
}
