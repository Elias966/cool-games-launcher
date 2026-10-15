/* Test rootfs package installation only. A single-ID user namespace cannot
 * chown to package service users. Simulate ownership, never preload in the app. */
int chown(const char *path, unsigned int uid, unsigned int gid) { return 0; }
int lchown(const char *path, unsigned int uid, unsigned int gid) { return 0; }
int fchown(int fd, unsigned int uid, unsigned int gid) { return 0; }
int fchownat(int fd, const char *path, unsigned int uid, unsigned int gid, int flags) { return 0; }
