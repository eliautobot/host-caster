// Picking audio files to import. The WebView file chooser handles this on Android (Storage Access Framework,
// several files at once) and iOS (Files), so one code path serves web and the apps.

export const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.flac,.ogg,.oga,.opus,.wav,.weba,.webm,.aiff,.aif';

export interface PickOptions {
  multiple?: boolean;
  accept?: string;
}

/**
 * Opens the system picker and resolves with the chosen files ([] when cancelled).
 * Call it from a click/tap handler (browsers only open pickers on a user gesture).
 */
export function pickAudioFiles(opts: PickOptions = {}): Promise<File[]> {
  if (typeof document === 'undefined') return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = opts.accept ?? AUDIO_ACCEPT;
    input.multiple = opts.multiple ?? true;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.setAttribute('aria-hidden', 'true');
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
