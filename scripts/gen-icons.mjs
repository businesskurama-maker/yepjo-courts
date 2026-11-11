// Generates the PWA icons and favicon from public/logo.webp (runs before every build).
// Keeps the logo's proportions; the maskable icon gets a safe-zone margin.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const SRC = 'public/logo.webp';
const BG = { r: 11, g: 12, b: 13, alpha: 1 }; // #0b0c0d, the app background
mkdirSync('public/icons', { recursive: true });

const square = (size, file) =>
  sharp(SRC).resize(size, size, { fit: 'contain', background: BG }).flatten({ background: BG })
    .png({ palette: true, quality: 90, compressionLevel: 9 }).toFile(file);

const padded = async (size, inner, file) => {
  const logo = await sharp(SRC).resize(inner, inner, { fit: 'contain', background: BG }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: 'center' }]).flatten({ background: BG })
    .png({ palette: true, quality: 90, compressionLevel: 9 }).toFile(file);
};

await Promise.all([
  square(512, 'public/icons/icon-512.png'),
  square(192, 'public/icons/icon-192.png'),
  padded(180, 160, 'public/icons/apple-touch-icon.png'),
  padded(512, 400, 'public/icons/maskable-512.png'),
  square(64, 'public/favicon.png'),
]);
console.log('icons generated from', SRC);
