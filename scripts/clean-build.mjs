import { lstat, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(project, 'dist-3d');
// This is the new, generated 3D directory only. Never touch dist/, source, or assets.
if (path.dirname(output) !== path.resolve(project) || path.basename(output) !== 'dist-3d') throw new Error('Unsafe output directory');
try { if ((await lstat(output)).isSymbolicLink()) throw new Error('Refusing to clean a symlink'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
