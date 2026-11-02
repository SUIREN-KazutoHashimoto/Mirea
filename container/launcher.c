/* Unprivileged Linux entrypoint. Apply restrictions BEFORE Node creates threads.
 * Requires Landlock ABI 3 (Linux 6.2+) and the normal Docker seccomp profile.
 * No root bootstrap, capabilities, environment-controlled bypass, or fallback.
 * See docs/container-security.md for the precise (not Docker-flag-equivalent)
 * contract and kernel documentation links.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <linux/capability.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

static void fail(const char *message) {
    fprintf(stderr, "Mirea container sandbox: %s (errno=%d). Refusing startup.\n", message, errno);
    exit(78);
}

static void identity(void) {
    uid_t real_uid, effective_uid, saved_uid;
    gid_t real_gid, effective_gid, saved_gid;
    if (getresuid(&real_uid, &effective_uid, &saved_uid) || getresgid(&real_gid, &effective_gid, &saved_gid) ||
        real_uid != effective_uid || real_uid != saved_uid || real_gid != effective_gid || real_gid != saved_gid)
        fail("real/effective/saved identities must match");
    if (getuid() == 0 || geteuid() == 0 || getgid() == 0 || getegid() == 0 ||
        getuid() != geteuid() || getgid() != getegid()) fail("non-root UID/GID required");
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3 };
    struct __user_cap_data_struct caps[2] = {0};
    if (syscall(SYS_capget, &header, caps)) fail("cannot inspect capabilities");
    for (int i = 0; i < 2; i++)
        if (caps[i].effective || caps[i].permitted || caps[i].inheritable) fail("capabilities must be empty");
    for (unsigned int i = 0; i < 64; i++) {
        int active = prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, i, 0, 0);
        if (active > 0 || (active < 0 && errno != EINVAL)) fail("ambient capability check failed");
        if (active < 0) break;
    }
    if (prctl(PR_GET_SECCOMP, 0, 0, 0, 0) != 2) fail("Docker seccomp filter required; privileged mode unsupported");
}

static void rule(int ruleset, const char *path, unsigned long long rights, int directory) {
    struct stat before, after;
    char *resolved = realpath(path, NULL);
    if (!resolved || strcmp(resolved, path)) fail("sandbox paths must exist and not be symlinks");
    free(resolved);
    if (lstat(path, &before) || (directory ? !S_ISDIR(before.st_mode) : !S_ISCHR(before.st_mode)))
        fail("unexpected sandbox path type");
    if ((rights & LANDLOCK_ACCESS_FS_EXECUTE) && (before.st_uid != 0 || (before.st_mode & 0022)))
        fail("executable roots must be root-owned and not group/other writable");
    int fd = open(path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0 || fstat(fd, &after) || before.st_dev != after.st_dev || before.st_ino != after.st_ino)
        fail("sandbox path changed");
    struct landlock_path_beneath_attr attr = { .allowed_access = rights, .parent_fd = fd };
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &attr, 0)) fail("cannot add filesystem rule");
    if (close(fd)) fail("cannot close path descriptor");
}

int main(int argc, char **argv) {
    if (argc < 2 || argv[1][0] != '/') fail("absolute executable required");
    identity();
    if (strcmp(getenv("DATA_DIR") ? getenv("DATA_DIR") : "", "/data") ||
        (getenv("MEDIA_DIR") && strcmp(getenv("MEDIA_DIR"), "/media")))
        fail("container storage must use /data and optional /media");
    /* SQLite's Unix VFS otherwise tries /var/tmp before /tmp. Its access()
     * probe can succeed even though Landlock denies the later open(), causing
     * SQLITE_CANTOPEN only when a sort or cascade statement journal spills.
     * Pin the existing allowed scratch root before SQLite/Node initialize;
     * do not widen the sandbox or move journals into persistent media. */
    if (setenv("SQLITE_TMPDIR", "/tmp", 1)) fail("cannot configure SQLite temporary storage");
    /* No inherited directory/file descriptors may bypass path enforcement.
     * close_range exists on every kernel capable of required Landlock ABI 3. */
    if (syscall(SYS_close_range, 3U, ~0U, 0)) fail("cannot close inherited descriptors");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1)
        fail("cannot prohibit privilege gains");
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 3) fail("Landlock ABI >= 3 required; enable supported host security, do not disable this check");
    const unsigned long long write_rights = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
    struct landlock_ruleset_attr attr = { .handled_access_fs = write_rights | LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM };
    int fd = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (fd < 0) fail("cannot create filesystem ruleset");
    rule(fd, "/data", write_rights, 1);
    if (getenv("MEDIA_DIR")) rule(fd, "/media", write_rights, 1);
    rule(fd, "/tmp", write_rights, 1);
    /* Node's ignored stdio opens /dev/null; no other device write is allowed. */
    rule(fd, "/dev/null", LANDLOCK_ACCESS_FS_WRITE_FILE, 0);
    rule(fd, "/usr", LANDLOCK_ACCESS_FS_EXECUTE, 1);
    rule(fd, "/app", LANDLOCK_ACCESS_FS_EXECUTE, 1);
    if (syscall(SYS_landlock_restrict_self, fd, 0)) fail("cannot enforce filesystem restrictions");
    if (close(fd)) fail("cannot close ruleset descriptor");
    umask(0077);
    fprintf(stderr, "Mirea container sandbox enforced: uid=%u gid=%u no_new_privs=1 landlock_abi=%d\n",
        (unsigned int)getuid(), (unsigned int)getgid(), abi);
    execv(argv[1], &argv[1]);
    fail("cannot execute service");
}
