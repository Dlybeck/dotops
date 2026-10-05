/* Linux-only syscall faults for isolated helper tests; never linked into helper. */
#define _GNU_SOURCE
#include <unistd.h>
#include <sys/syscall.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

int fsync(int fd) {
  static unsigned calls;
  const char *fault = getenv("DOTOPS_FIXTURE_FAULT");
  calls++;
  if (fault && !strcmp(fault, "crash-before-rename") && calls == 1) _exit(77);
  if (fault && ((!strcmp(fault, "file-sync") && calls == 1) || (!strcmp(fault, "directory-sync") && calls == 2))) {
    errno = EIO; return -1;
  }
  return (int)syscall(SYS_fsync, fd);
}

int renameat(int olddir, const char *old, int newdir, const char *new) {
  const char *fault = getenv("DOTOPS_FIXTURE_FAULT");
  if (fault && !strcmp(fault, "rename")) { errno = EIO; return -1; }
  return (int)syscall(SYS_renameat, olddir, old, newdir, new);
}
