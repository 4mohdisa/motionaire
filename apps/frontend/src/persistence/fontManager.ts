import { invoke } from '@tauri-apps/api/core'
import { open, message } from '@tauri-apps/plugin-dialog'
import { useStore } from '../state/store'
import { uid } from '../types/project'

// Custom fonts (session 8, Phase 4). Bytes live in the bundle's fonts/ dir;
// project.json stores only metadata. In memory: a module-level byte cache so
// save can re-embed without re-reading, plus FontFace registration for the
// DOM text overlays (the text-into-compositor path will reuse these bytes).

export interface BundleFont {
  fileName: string
  dataBase64: string
}

const fontBytes = new Map<string, string>() // fileName → base64
const registered = new Set<string>() // families

function familyFromFileName(fileName: string): string {
  // ponytail: family = file stem; real name-table parsing when a font whose
  // stem differs from its family actually bites someone.
  return fileName.replace(/\.(ttf|otf)$/i, '')
}

async function register(family: string, base64: string): Promise<boolean> {
  if (registered.has(family)) return true
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const face = new FontFace(family, bytes.buffer as ArrayBuffer)
    await face.load()
    document.fonts.add(face)
    registered.add(family)
    return true
  } catch (e) {
    console.error(`font ${family} failed to load:`, e)
    return false
  }
}

export async function importFontFlow(): Promise<void> {
  const picked = await open({
    title: 'Import font',
    multiple: false,
    filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }],
  })
  if (typeof picked !== 'string') return
  try {
    const font = await invoke<BundleFont>('import_font', { path: picked })
    const family = familyFromFileName(font.fileName)
    if (!(await register(family, font.dataBase64))) {
      await message(`"${font.fileName}" could not be loaded as a font.`, {
        title: 'Font import failed',
        kind: 'error',
      })
      return
    }
    fontBytes.set(font.fileName, font.dataBase64)
    useStore.getState().addProjectFont({ id: uid('f'), family, fileName: font.fileName })
  } catch (e) {
    await message(`Couldn't import font:\n${e}`, { title: 'Font import failed', kind: 'error' })
  }
}

// Called by saveProject: embed all referenced fonts into the bundle.
export async function persistFonts(bundlePath: string): Promise<void> {
  const fonts = useStore.getState().project.fonts ?? []
  const payload = fonts
    .map((f) => ({ fileName: f.fileName, dataBase64: fontBytes.get(f.fileName) }))
    .filter((f): f is BundleFont => !!f.dataBase64)
  if (payload.length)
    await invoke('save_fonts', { bundlePath, fonts: payload }).catch((e) =>
      console.error('save_fonts failed:', e),
    )
}

// Called by openProjectPath: register fonts shipped inside the bundle.
export async function restoreFonts(fonts: BundleFont[]): Promise<void> {
  for (const f of fonts) {
    fontBytes.set(f.fileName, f.dataBase64)
    await register(familyFromFileName(f.fileName), f.dataBase64)
  }
}

export function customFamilies(): string[] {
  return (useStore.getState().project.fonts ?? []).map((f) => f.family)
}
