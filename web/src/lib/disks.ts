import type { DiskKind } from '../api/types';

const PSEUDO_FS = new Set([
  'tmpfs',
  'devtmpfs',
  'devfs',
  'udev',
  'efivarfs',
  'none',
  'shm',
  'overlay',
  'squashfs',
  'iso9660',
  'ramfs',
  'devpts',
  'sysfs',
  'proc',
  'securityfs',
  'cgroup',
  'cgroup2',
  'pstore',
  'autofs',
  'mqueue',
  'debugfs',
  'tracefs',
  'fusectl',
  'configfs',
  'binfmt_misc',
  'hugetlbfs',
  'nsfs',
  'bpf',
]);

/**
 * Classifies a filesystem row into local host storage, external/mounted storage (NAS, NFS, CIFS, /mnt, /media),
 * or pseudo/ephemeral in-memory filesystems.
 */
export function classifyDisk(filesystem: string, mount: string): DiskKind {
  const fs = (filesystem ?? '').trim().toLowerCase();
  const m = (mount ?? '').trim();

  // 1. Pseudo / ephemeral in-memory filesystems
  if (PSEUDO_FS.has(fs)) return 'pseudo';
  if (
    m === '/run' ||
    m.startsWith('/run/') ||
    m === '/sys' ||
    m.startsWith('/sys/') ||
    m === '/dev' ||
    m.startsWith('/dev/') ||
    m === '/proc' ||
    m.startsWith('/proc/') ||
    m.includes('/credentials/') ||
    m.includes('/containerd/') ||
    m.includes('/docker/overlay2/')
  ) {
    return 'pseudo';
  }

  // 2. External / network / mounted remote storage
  if (
    m === '/mnt' ||
    m.startsWith('/mnt/') ||
    m === '/media' ||
    m.startsWith('/media/') ||
    m === '/net' ||
    m.startsWith('/net/')
  ) {
    return 'external';
  }
  if (m.startsWith('/Volumes/') && !m.startsWith('/Volumes/Macintosh HD')) {
    return 'external';
  }
  if (
    fs.startsWith('//') ||
    (fs.includes(':') && !fs.startsWith('/')) ||
    fs.startsWith('nfs') ||
    fs.startsWith('cifs') ||
    fs.startsWith('smb') ||
    fs.startsWith('sshfs') ||
    fs.startsWith('fuse.sshfs') ||
    fs.startsWith('fuse.rclone') ||
    fs.startsWith('davfs') ||
    fs.startsWith('fuse.davfs') ||
    fs.startsWith('glusterfs') ||
    fs.startsWith('ceph')
  ) {
    return 'external';
  }

  // 3. Physical / local disk
  return 'local';
}

/** Returns the disk's kind, falling back to classification if not provided by server. */
export function getDiskKind(disk: { filesystem: string; mount: string; kind?: DiskKind }): DiskKind {
  return disk.kind ?? classifyDisk(disk.filesystem, disk.mount);
}
