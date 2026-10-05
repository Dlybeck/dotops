import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from '../../safety.mjs';

// Run trusted system code before any user-built executable. The script is a
// constant, receives only canonical paths, and neither changes ACLs nor uses
// Apple events, applications, a shell, authentication or the network.
// Ref/pointer and Darwin API behavior require actual macOS acceptance.
export const ACL_SCRIPT = `
ObjC.import('Foundation');
ObjC.bindFunction('acl_get_link_np', ['void *', ['char *', 'int']]);
ObjC.bindFunction('acl_valid', ['int', ['void *']]);
ObjC.bindFunction('acl_get_entry', ['int', ['void *', 'int', 'void **']]);
ObjC.bindFunction('acl_get_tag_type', ['int', ['void *', 'int *']]);
ObjC.bindFunction('acl_free', ['int', ['void *']]);
ObjC.bindFunction('__error', ['int *', []]);
function run(paths) {
  if (!paths.length || paths.length > 128) throw Error('UNSAFE');
  for (var p = 0; p < paths.length; p++) {
    if (paths[p][0] !== '/' || paths[p].indexOf('\\0') !== -1) throw Error('UNSAFE');
    var acl = $.acl_get_link_np(paths[p], 256);
    if ($.acl_valid(acl) !== 0) throw Error('UNSAFE');
    try {
      var entry = Ref(), tag = Ref(), errno = $.__error(), selector = 0, count = 0;
      for (;;) {
        errno[0] = 0;
        var result = $.acl_get_entry(acl, selector, entry);
        if (result === -1 && errno[0] === 22) break;
        if (result !== 0 || ++count > 128) throw Error('UNSAFE');
        if ($.acl_get_tag_type(entry[0], tag) !== 0 || tag[0] !== 2) throw Error('UNSAFE');
        selector = -1;
      }
    } finally {
      if ($.acl_free(acl) !== 0) throw Error('UNSAFE');
    }
  }
  return 'DOTOPS_ACL_SAFE';
}
`;

export async function checkDarwinExecutableAcls(paths, execute = promisify(execFile)) {
  try {
    if (!paths.length || paths.length > 128 || paths.some(p => typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')))
      fail('UNSAFE_STATE_HELPER');
    const { stdout, stderr } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ACL_SCRIPT, ...paths],
      { env: { LC_ALL: 'C' }, timeout: 3000, maxBuffer: 1024, killSignal: 'SIGKILL' });
    if (stdout !== 'DOTOPS_ACL_SAFE\n' || stderr !== '') fail('UNSAFE_STATE_HELPER');
  } catch { fail('UNSAFE_STATE_HELPER'); }
}
