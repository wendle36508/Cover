// share.js - "Sponsor me" links, QR codes and the printable sign (Nov 23, 2026).
// Share links look like go.covergiving.com/lucky-pup-rescue/burt. When pasted into Facebook, Messages
// or a text they show the dog's photo (Cover's Cloudflare helper, cloudflare/share, answers those),
// and a tap goes straight to the sponsor page. Used by the dashboard's Share box and by sign.html.

import { itemSlug } from "./sponsor.js";

export const SHARE_ORIGIN = "https://go.covergiving.com";
const QR_QUIET_MODULES = 4; // the white border scanners need around a QR code

/** A nonprofit's share link, or one dog's: go.covergiving.com/lucky-pup-rescue(/burt). */
export function shareLink(orgSlug, itemName = null) {
  return itemName ? `${SHARE_ORIGIN}/${orgSlug}/${itemSlug(itemName)}` : `${SHARE_ORIGIN}/${orgSlug}`;
}

/** The printable sign's address, for the whole page or one dog. */
export function signLink(orgSlug, itemName = null) {
  const params = new URLSearchParams({ org: orgSlug });
  if (itemName) params.set("dog", itemSlug(itemName));
  return `sign.html?${params}`;
}

/** A tidy file name for a downloaded QR code: "lucky-pup-rescue-burt-qr.png". */
export function qrFileName(orgSlug, itemName = null) {
  return `${[orgSlug, itemName ? itemSlug(itemName) : ""].filter(Boolean).join("-")}-qr.png`;
}

/**
 * Draw a QR code for `text` on a canvas, black on white, `size` pixels wide. Returns false if the QR
 * maker isn't available (the rest of the Share box still works). The QR maker is loaded only when needed.
 */
export async function drawQr(canvas, text, size = 600) {
  let makeQr;
  try {
    makeQr = (await import("./vendor/qrcode.js")).default;
  } catch {
    return false;
  }
  const qr = makeQr(0, "M"); // 0 = smallest code that fits; M = still scans with a bit of damage
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const cell = Math.floor(size / (modules + QR_QUIET_MODULES * 2));
  const total = cell * (modules + QR_QUIET_MODULES * 2);
  canvas.width = total;
  canvas.height = total;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (qr.isDark(row, col)) ctx.fillRect((col + QR_QUIET_MODULES) * cell, (row + QR_QUIET_MODULES) * cell, cell, cell);
    }
  }
  return true;
}
