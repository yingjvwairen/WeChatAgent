import fs from 'node:fs';
import path from 'node:path';

/** Installed packages carry a versioned OCR runtime; source checkouts use venv. */
export function ocrPython(root) {
  const file = path.join(root, 'config/distribution.json');
  if (fs.existsSync(file)) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (
      value.installed === true &&
      value.desktopRuntime === true &&
      typeof value.ocrPython === 'string' &&
      path.isAbsolute(value.ocrPython)
    )
      return value.ocrPython;
  }
  return path.join(root, 'state/ocr/venv/Scripts/python.exe');
}
