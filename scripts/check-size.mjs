import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('dist-3d');
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(path.join(dir, e.name)) : path.join(dir, e.name)))).flat();
}
const list = await files(root);
const sizes = await Promise.all(list.map(async f => ({ file: path.relative(root, f), bytes: (await stat(f)).size })));
const total = sizes.reduce((n, f) => n + f.bytes, 0);
console.table(sizes); console.log(`Distribution: ${total} bytes / 5242880 bytes (${(total / 1048576).toFixed(3)} MiB)`);
if (total >= 5242880) throw new Error('5 MiB distribution budget exceeded');
for (const f of list) if (/\.map$|assets[/\\]characters|manifest\.webmanifest/.test(f)) throw new Error(`Unexpected legacy/debug distribution asset: ${f}`);
for (const name of ['shokupan', 'francepan', 'croissant', 'melonpan', 'currypan', 'creampan']) {
  const output = await readFile(path.join(root, 'assets/models', `${name}.glb`));
  const source = await readFile(`public/assets/models/${name}.glb`);
  if (!output.equals(source)) throw new Error(`Model modified: ${name}`);
}
