/* Private journal helper. No pathname commands, shell, network or model APIs.
 * argv supplies one canonical state directory. The pipe accepts only bounded
 * state replacement (W) and close (Q); EOF releases the kernel writer lock.
 * Linux builds are POSIX fixtures, never evidence of Darwin ACL correctness. */
#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#ifdef __APPLE__
#include <sys/acl.h>
#include <sys/random.h>
#elif defined(DOTOPS_LINUX_FIXTURE)
#include <sys/xattr.h>
#else
#error "Build on macOS, or explicitly select DOTOPS_LINUX_FIXTURE for tests"
#endif
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

#define STATE_LIMIT (2U * 1024U * 1024U)
static uid_t owner;
static const char *state_path;
static int directory = -1, guard = -1;

static int write_all(int fd, const void *data, size_t size) {
  const unsigned char *p = data;
  while (size) {
    ssize_t n = write(fd, p, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    p += n; size -= (size_t)n;
  }
  return 0;
}

/* 1 = complete, 0 = EOF, -1 = truncated/error. */
static int read_exact(int fd, void *data, size_t size) {
  unsigned char *p = data; size_t remaining = size;
  while (remaining) {
    ssize_t n = read(fd, p, remaining);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) return -1;
    if (n == 0) return remaining == size ? 0 : -1;
    p += n; remaining -= (size_t)n;
  }
  return 1;
}

static int frame(char type, const void *data, uint32_t size) {
  unsigned char header[5] = { (unsigned char)type, (unsigned char)(size >> 24),
    (unsigned char)(size >> 16), (unsigned char)(size >> 8), (unsigned char)size };
  return write_all(STDOUT_FILENO, header, sizeof header) || write_all(STDOUT_FILENO, data, size);
}

static void reject(const char *code) {
  (void)frame('E', code, (uint32_t)strlen(code));
  exit(1); /* Process exit releases descriptors and flock; no payload logging. */
}

static int safe_acl(int fd, int is_directory) {
#ifdef __APPLE__
  (void)is_directory;
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return 0;
  if (acl_valid(acl) != 0) { acl_free(acl); return 0; }
  acl_entry_t entry; int selector = ACL_FIRST_ENTRY, result;
  /* Conservative: deny-only ACLs are allowed; any explicit grant is rejected,
   * including an otherwise harmless grant. Never chmod or strip inherited ACLs. */
  while ((result = acl_get_entry(acl, selector, &entry)) == 0) {
    selector = ACL_NEXT_ENTRY;
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag) != 0 || tag != ACL_EXTENDED_DENY) {
      acl_free(acl); return 0;
    }
  }
  /* Darwin returns -1/EINVAL at the end, unlike Linux's POSIX ACL API. */
  int end_error = errno;
  acl_free(acl);
  return result == -1 && end_error == EINVAL;
#else
  const char *names[] = { "system.posix_acl_access", "system.posix_acl_default" };
  for (int i = 0; i < (is_directory ? 2 : 1); i++) {
    ssize_t size = fgetxattr(fd, names[i], NULL, 0);
    if (size >= 0 || errno != ENODATA) return 0;
  }
  return 1;
#endif
}

static int safe_parent(int fd, struct stat *st) {
  if (fstat(fd, st) < 0 || !S_ISDIR(st->st_mode) ||
      (st->st_uid != 0 && st->st_uid != owner) || !safe_acl(fd, 1)) return 0;
  return !(st->st_mode & 0022) || (st->st_uid == 0 && (st->st_mode & S_ISVTX));
}

static int open_directory(int parent, const char *name) {
  return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

static int traverse(int create) {
  char copy[PATH_MAX];
  if (strlen(state_path) >= sizeof copy || state_path[0] != '/' || !state_path[1])
    reject("UNSAFE_STATE_DIRECTORY");
  strcpy(copy, state_path);
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) reject("UNSAFE_STATE_DIRECTORY");
  char *component = copy + 1;
  while (*component) {
    char *separator = strchr(component, '/');
    if (separator) *separator = '\0';
    if (!*component || !strcmp(component, ".") || !strcmp(component, ".."))
      reject("UNSAFE_STATE_DIRECTORY");
    struct stat parent;
    if (!safe_parent(fd, &parent)) reject("UNSAFE_STATE_DIRECTORY");
    int next = open_directory(fd, component);
    if (next < 0 && errno == ENOENT && create) {
      if (parent.st_uid != owner || (parent.st_mode & 0022)) reject("UNSAFE_STATE_DIRECTORY");
      if (mkdirat(fd, component, 0700) < 0 && errno != EEXIST) reject("UNSAFE_STATE_DIRECTORY");
      next = open_directory(fd, component);
    }
    if (next < 0) reject("UNSAFE_STATE_DIRECTORY");
    close(fd); fd = next;
    if (!separator) break;
    component = separator + 1;
    if (!*component) reject("UNSAFE_STATE_DIRECTORY");
  }
  struct stat leaf;
  char canonical[PATH_MAX];
  if (fstat(fd, &leaf) < 0 || !S_ISDIR(leaf.st_mode) || leaf.st_uid != owner ||
      (leaf.st_mode & 07777) != 0700 || !safe_acl(fd, 1) ||
      !realpath(state_path, canonical) || strcmp(canonical, state_path)) reject("UNSAFE_STATE_DIRECTORY");
  return fd;
}

static void private_file(int fd, const char *code, int bounded) {
  struct stat st;
  if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_uid != owner ||
      (st.st_mode & 07777) != 0600 || st.st_nlink != 1 || !safe_acl(fd, 0) ||
      (bounded && (st.st_size < 0 || (uint64_t)st.st_size > STATE_LIMIT))) reject(code);
}

static int same_identity(int a, int b) {
  struct stat left, right;
  return fstat(a, &left) == 0 && fstat(b, &right) == 0 &&
    left.st_dev == right.st_dev && left.st_ino == right.st_ino;
}

static void check_identity(void) {
  int current = traverse(0);
  if (!same_identity(directory, current)) reject("STATE_LOCK_LOST");
  close(current);
  int lock = openat(directory, "advisory.lock", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (lock < 0 || !same_identity(guard, lock)) reject("STATE_LOCK_LOST");
  private_file(lock, "UNSAFE_STATE_LOCK", 0); close(lock);
}

static int state_file(void) {
  int fd = openat(directory, "state.json", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 && errno == ENOENT) return -1;
  if (fd < 0) reject("UNSAFE_STATE_FILE");
  private_file(fd, "UNSAFE_STATE_FILE", 1);
  return fd;
}

static void initial_state(void) {
  check_identity();
  int fd = state_file();
  if (fd < 0) { if (frame('R', NULL, 0)) exit(1); return; }
  unsigned char *bytes = malloc(STATE_LIMIT + 1U);
  if (!bytes) reject("STATE_IO_ERROR");
  size_t size = 0;
  for (;;) {
    ssize_t n = read(fd, bytes + size, STATE_LIMIT + 1U - size);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) reject("STATE_IO_ERROR");
    if (n == 0) break;
    size += (size_t)n;
    if (size > STATE_LIMIT) reject("UNSAFE_STATE_FILE");
  }
  close(fd); check_identity();
  if (size == 0) reject("INVALID_STATE");
  if (frame('R', bytes, (uint32_t)size)) exit(1);
  free(bytes);
}

static void commit(const unsigned char *bytes, uint32_t size) {
  check_identity();
  int old = state_file(); if (old >= 0) close(old);
  uint64_t nonce;
  if (getentropy(&nonce, sizeof nonce) < 0) reject("STATE_IO_ERROR");
  char temporary[64];
  snprintf(temporary, sizeof temporary, "state.json.%016" PRIx64, nonce);
  int fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) reject("STATE_IO_ERROR");
  private_file(fd, "UNSAFE_STATE_FILE", 1);
  int failed = write_all(fd, bytes, size) || fsync(fd) < 0;
  if (close(fd) < 0) failed = 1;
  if (failed) { unlinkat(directory, temporary, 0); reject("STATE_IO_ERROR"); }
  check_identity();
  old = state_file(); if (old >= 0) close(old);
  if (renameat(directory, temporary, directory, "state.json") < 0) {
    unlinkat(directory, temporary, 0); reject("STATE_IO_ERROR");
  }
  if (fsync(directory) < 0) reject("STATE_IO_ERROR");
  if (frame('A', NULL, 0)) exit(1);
}

int main(int argc, char **argv) {
  owner = getuid();
  if (argc != 2 || owner == 0 || geteuid() != owner || getegid() != getgid()) reject("NORMAL_USER_REQUIRED");
  umask(0077); signal(SIGPIPE, SIG_IGN);
  state_path = argv[1]; directory = traverse(1);
  guard = openat(directory, "advisory.lock", O_RDWR | O_CREAT | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (guard < 0) reject("UNSAFE_STATE_LOCK");
  private_file(guard, "UNSAFE_STATE_LOCK", 0);
  if (flock(guard, LOCK_EX | LOCK_NB) < 0) reject("WATCHDOG_ALREADY_RUNNING");
  initial_state();
  for (;;) {
    unsigned char header[5];
    int read_status = read_exact(STDIN_FILENO, header, sizeof header);
    if (read_status == 0) return 0;
    if (read_status < 0) reject("INVALID_HELPER_REQUEST");
    uint32_t size = (uint32_t)header[1] << 24 | (uint32_t)header[2] << 16 |
      (uint32_t)header[3] << 8 | (uint32_t)header[4];
    if (header[0] == 'Q' && size == 0) return 0;
    if (header[0] != 'W' || !size || size > STATE_LIMIT) reject("INVALID_HELPER_REQUEST");
    unsigned char *bytes = malloc(size);
    if (!bytes) reject("STATE_IO_ERROR");
    if (read_exact(STDIN_FILENO, bytes, size) != 1) reject("INVALID_HELPER_REQUEST");
    commit(bytes, size); free(bytes);
  }
}
