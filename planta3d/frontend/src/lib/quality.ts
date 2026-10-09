// Revisión inmediata en el dispositivo, antes de subir: formato real y un indicador rápido de nitidez y
// exposición. Es orientativo; el servidor vuelve a validar todo y conserva el original.

export type Sniff = "jpeg" | "png" | "heic" | "raw" | "video" | "archive" | "otro";

export async function sniffFile(f: File): Promise<Sniff> {
  const b = new Uint8Array(await f.slice(0, 16).arrayBuffer());
  const s = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && s(1, 3) === "PNG") return "png";
  if (s(4, 4) === "ftyp") return ["heic", "heix", "hevc", "mif1", "msf1"].includes(s(8, 4)) ? "heic" : "video";
  if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) return "raw";
  if (b[0] === 0x50 && b[1] === 0x4b) return "archive";
  return "otro";
}

export const SNIFF_HELP: Record<string, string> = {
  heic: "HEIC no admitido aún: en iPhone usa Ajustes › Cámara › Formatos › «Más compatible».",
  raw: "RAW/DNG/TIFF no admitido: exporta JPEG de máxima calidad.",
  video: "Vídeo no admitido: toma fotos deteniéndote en cada posición.",
  archive: "Archivos comprimidos no admitidos: sube las fotos sueltas.",
  otro: "No es una imagen JPEG o PNG.",
};

export interface QuickQuality { sharpness: number; dark: number; bright: number; width: number; height: number }

export async function quickQuality(f: File): Promise<QuickQuality | null> {
  try {
    const bmp = await createImageBitmap(f);
    const W = 512;
    const scale = Math.min(1, W / Math.max(bmp.width, bmp.height));
    const w = Math.max(8, Math.round(bmp.width * scale)), h = Math.max(8, Math.round(bmp.height * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let dark = 0, bright = 0;
    for (let i = 0; i < w * h; i++) {
      const y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      g[i] = y;
      if (y < 16) dark++;
      if (y > 245) bright++;
    }
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = -4 * g[i] + g[i - 1] + g[i + 1] + g[i - w] + g[i + w];
      sum += l; sum2 += l * l; n++;
    }
    const mean = sum / n;
    const res = { sharpness: sum2 / n - mean * mean, dark: dark / (w * h), bright: bright / (w * h), width: bmp.width, height: bmp.height };
    bmp.close();
    return res;
  } catch {
    return null;
  }
}

/** Indicador relativo: compara con la mediana de lo ya revisado en esta sesión. */
export function qualityHint(q: QuickQuality | null, median: number | null): { level: "ok" | "warn" | "bad"; text: string } {
  if (!q) return { level: "warn", text: "No se pudo analizar en el dispositivo" };
  if (q.dark > 0.45) return { level: "warn", text: "Posible subexposición" };
  if (q.bright > 0.25) return { level: "warn", text: "Posibles reflejos/sobreexposición" };
  if (median && q.sharpness < 0.35 * median) return { level: "bad", text: "Posible foto movida: repítela" };
  if (q.sharpness < 20) return { level: "warn", text: "Nitidez baja" };
  return { level: "ok", text: "Nítida" };
}
