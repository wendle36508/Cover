// welcome-image.js - draws the shareable "Welcome Sarah, Bella's newest sponsor!" picture
// (Tanner's pick, Nov 15: look B, the dog's photo with handwriting over it).
// Runs in the owner's browser on a <canvas>, so it's JavaScript, not Python. Nothing is uploaded:
// the owner downloads the picture and posts it themselves. Cover never posts for them.

import { brandColors } from "./brand.js";
import { wrapLines } from "./dashboard-logic.js";

export const SIZE = 1080; // square, the size Instagram and Facebook use
const PAD = 64;
const COVER_GREEN = "#22C67A"; // used when the nonprofit hasn't picked a brand color
const HAND = "Caveat";
const SANS = '"Plus Jakarta Sans", system-ui, sans-serif';

/** Load a photo for drawing. Resolves null if it can't load (then the picture uses the brand color). */
function loadPhoto(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // so the finished picture can still be downloaded
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Draw the photo filling the square, cropped around its focus point (percent x and y). */
function drawPhoto(ctx, img, focus) {
  const scale = Math.max(SIZE / img.naturalWidth, SIZE / img.naturalHeight);
  const width = img.naturalWidth * scale;
  const height = img.naturalHeight * scale;
  const x = Math.min(0, Math.max(SIZE - width, SIZE / 2 - (width * focus.x) / 100));
  const y = Math.min(0, Math.max(SIZE - height, SIZE / 2 - (height * focus.y) / 100));
  ctx.drawImage(img, x, y, width, height);
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** The nonprofit's name on a brand-color tag in the top corner. */
function drawTag(ctx, name, colors) {
  ctx.font = `800 40px ${SANS}`;
  const text = name.length > 32 ? `${name.slice(0, 31)}…` : name;
  const width = ctx.measureText(text).width + 52;
  roundedRect(ctx, PAD, PAD, width, 78, 18);
  ctx.fillStyle = colors["--green"];
  ctx.fill();
  ctx.fillStyle = colors["--on-green"];
  ctx.textBaseline = "middle";
  ctx.fillText(text, PAD + 26, PAD + 41);
}

/** The handwritten welcome, as big as fits in three lines, anchored to the bottom. */
function drawHeadline(ctx, headline, colors) {
  const maxWidth = SIZE - PAD * 2;
  let size = 132;
  let lines;
  do {
    ctx.font = `700 ${size}px ${HAND}`;
    lines = wrapLines(headline, maxWidth, (t) => ctx.measureText(t).width);
    size -= 6;
  } while ((lines.length > 3 || lines.some((l) => ctx.measureText(l).width > maxWidth)) && size > 60);
  size += 6;
  const lineHeight = size * 0.98;
  let y = SIZE - PAD - lineHeight * (lines.length - 1);
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 30px ${SANS}`;
  ctx.fillStyle = colors["--mint"];
  ctx.letterSpacing = "3px";
  ctx.fillText("NEW SPONSOR", PAD + 4, y - lineHeight * 0.92);
  ctx.letterSpacing = "0px";
  ctx.font = `700 ${size}px ${HAND}`;
  ctx.fillStyle = "#FFFFFF";
  ctx.shadowColor = "rgba(0, 0, 0, .35)";
  ctx.shadowBlur = 18;
  for (const line of lines) {
    ctx.fillText(line, PAD, y);
    y += lineHeight;
  }
  ctx.shadowBlur = 0;
}

/**
 * Draw the welcome picture onto a canvas.
 * details: { photoUrl, focus: { x, y }, brandColor, nonprofitName, headline }
 */
export async function drawWelcome(canvas, details) {
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  const colors = brandColors(details.brandColor) ?? brandColors(COVER_GREEN);
  await Promise.all([
    document.fonts.load(`700 120px ${HAND}`),
    document.fonts.load(`800 40px ${SANS}`),
  ]).catch(() => null);
  const photo = await loadPhoto(details.photoUrl);

  if (photo) drawPhoto(ctx, photo, details.focus ?? { x: 50, y: 38 });
  else {
    ctx.fillStyle = colors["--green"];
    ctx.fillRect(0, 0, SIZE, SIZE);
  }
  // Darken the bottom so the white handwriting is easy to read on any photo.
  const shade = ctx.createLinearGradient(0, SIZE * 0.38, 0, SIZE);
  shade.addColorStop(0, "rgba(20, 12, 8, 0)");
  shade.addColorStop(1, "rgba(20, 12, 8, .86)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, SIZE, SIZE);

  drawTag(ctx, details.nonprofitName, colors);
  drawHeadline(ctx, details.headline, colors);
  return Boolean(photo);
}

/** The finished picture as a PNG file, for the download button. */
export function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't make the picture."))), "image/png");
  });
}
