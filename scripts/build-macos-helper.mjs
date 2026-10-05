import { spawn } from 'node:child_process';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Explicit local build only. No installer, download, shell or lifecycle hook.
const args = process.argv.slice(2);
const fixture = args[0] === '--linux-fixture';
if (args.length !== (fixture ? 1 : 0) || (fixture ? process.platform !== 'linux' : process.platform !== 'darwin')) {
  console.error('Build on macOS, or explicitly use --linux-fixture on Linux.'); process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'native/build');
await mkdir(directory, { recursive: true });
const compiler = process.env.CC || (fixture ? 'cc' : '/usr/bin/clang');
async function compile(source, name, extra) {
  const output = path.join(directory, name), temporary = output + '.' + randomUUID();
  try {
    const flags = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', ...extra, path.join(root, source), '-o', temporary];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(compiler, flags, { stdio: 'inherit' });
      child.once('error', reject); child.once('exit', resolve);
    });
    if (code !== 0) throw new Error('Compiler failed');
    await rename(temporary, output);
  } finally { await unlink(temporary).catch(() => {}); }
}
try {
  await compile('native/macos/dotops-private-fs.c', 'dotops-private-fs', fixture ? ['-DDOTOPS_LINUX_FIXTURE'] : []);
  if (fixture) await compile('test/platform/fs-faults.c', 'fs-faults.so', ['-shared', '-fPIC']);
  console.log(fixture ? 'Built Linux POSIX fixture; Darwin ACL behavior is unverified.' : 'Built macOS journal helper; run platform tests before use.');
} catch {
  console.error('Helper build failed. Supply an existing C compiler with CC; no toolchain is installed automatically.');
  process.exitCode = 1;
}
