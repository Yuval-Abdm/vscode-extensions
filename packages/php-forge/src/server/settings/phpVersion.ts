// Version de PHP du projet : réglage, sinon composer.json (config.platform.php, require.php), sinon `php`
// installé, sinon 8.3.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PhpVersionSource } from '../../shared/protocol.ts';

export const DEFAULT_PHP_VERSION = '8.3';

interface Composer {
  require?: Record<string, string>;
  config?: { platform?: Record<string, string> };
}

export async function detectPhpVersion(folders: string[], configured: string, phpBinary = 'php'): Promise<{ version: string; source: PhpVersionSource }> {
  const setting = /^\d+(?:\.\d+)?/.exec(configured.trim())?.[0];
  if (setting) return { version: setting.includes('.') ? setting : `${setting}.0`, source: 'setting' };
  for (const folder of folders) {
    try {
      const composer = JSON.parse(await readFile(path.join(folder, 'composer.json'), 'utf8')) as Composer;
      const constraint = composer.config?.platform?.php ?? composer.require?.php;
      const version = constraint ? /(\d+)\.(\d+)/.exec(constraint) : null;
      if (version) return { version: `${version[1]}.${version[2]}`, source: 'composer' };
    } catch {
      // pas de composer.json lisible
    }
  }
  const installed = await new Promise<string | undefined>((resolve) => {
    execFile(phpBinary, ['-r', 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;'], { timeout: 3000 }, (error, stdout) => {
      resolve(error ? undefined : /^\d+\.\d+$/.exec(String(stdout).trim())?.[0]);
    });
  });
  if (installed) return { version: installed, source: 'php' };
  return { version: DEFAULT_PHP_VERSION, source: 'default' };
}
