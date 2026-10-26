import { describe, expect, it } from 'vitest';
import { classifyDisk, getDiskKind } from '../../src/lib/disks';
import { summarise } from '../../src/state/systemStatsStore';
import type { RemoteSystemStats } from '../../src/api/types';

describe('disks classification', () => {
  it('classifies local disks', () => {
    expect(classifyDisk('/dev/sda1', '/')).toBe('local');
    expect(classifyDisk('/dev/nvme0n1p2', '/boot/efi')).toBe('local');
    expect(classifyDisk('/dev/mapper/ubuntu-root', '/')).toBe('local');
    expect(classifyDisk('/dev/disk1s1', '/')).toBe('local');
    expect(getDiskKind({ filesystem: '/dev/sda1', mount: '/' })).toBe('local');
  });

  it('classifies external and mounted disks', () => {
    expect(classifyDisk('192.168.1.50:/volume1/releaseapp-mebel', '/mnt/releaseapp-mebel')).toBe('external');
    expect(classifyDisk('/dev/sdb1', '/mnt/backup')).toBe('external');
    expect(classifyDisk('/dev/sdc1', '/media/usb')).toBe('external');
    expect(classifyDisk('//nas/share', '/shares/nas')).toBe('external');
    expect(classifyDisk('nfs_share', '/data/nfs')).toBe('external');
    expect(classifyDisk('fuse.sshfs', '/remote')).toBe('external');
  });

  it('classifies pseudo filesystems', () => {
    expect(classifyDisk('tmpfs', '/run')).toBe('pseudo');
    expect(classifyDisk('tmpfs', '/dev/shm')).toBe('pseudo');
    expect(classifyDisk('efivarfs', '/sys/firmware/efi/efivars')).toBe('pseudo');
    expect(classifyDisk('ramfs', '/run/credentials/service')).toBe('pseudo');
    expect(classifyDisk('tmpfs', '/tmp')).toBe('pseudo');
  });
});

describe('summarise disk usage', () => {
  it('excludes external and pseudo disks from server disk space percentage', () => {
    const stats: RemoteSystemStats = {
      collectedAt: Date.now(),
      uptimeSeconds: 3600,
      load: [0.5, 0.4, 0.3],
      cpuCount: 4,
      memory: { totalBytes: 8_000_000, usedBytes: 4_000_000, availableBytes: 4_000_000 },
      swap: null,
      disks: [
        // Local root: 10%
        { filesystem: '/dev/sda1', sizeBytes: 100_000, usedBytes: 10_000, availableBytes: 90_000, mount: '/' },
        // Pseudo efivars: 90% (should be ignored)
        { filesystem: 'efivarfs', sizeBytes: 1_000, usedBytes: 900, availableBytes: 100, mount: '/sys/firmware/efi/efivars' },
        // External NAS: 80% (should be ignored for server disk percentage)
        { filesystem: '192.168.1.50:/share', sizeBytes: 1_000_000, usedBytes: 800_000, availableBytes: 200_000, mount: '/mnt/nas' },
      ],
      hostname: 'test-host',
      kernel: 'Linux',
      notes: [],
    };

    const summary = summarise(stats);
    // Should be 10%, NOT 80% (NAS) and NOT 90% (efivars)
    expect(summary.disk).toBe('10%');
  });
});
