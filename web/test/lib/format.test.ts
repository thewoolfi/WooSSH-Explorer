import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  describeKind,
  extensionOf,
  formatBytes,
  formatCount,
  formatDate,
  formatEta,
  formatFullDate,
  formatPercent,
  formatRelative,
  formatSizeColumn,
  formatSpeed,
  modeToOctal,
  modeToText,
} from '../../src/lib/format';

/** A local-time timestamp, so the assertions hold in any runner timezone. */
const localMs = (year: number, month: number, day: number, hours = 0, minutes = 0): number =>
  new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

describe('formatBytes', () => {
  test('shows raw bytes without a decimal below 1 KiB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(916)).toBe('916 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  test('switches unit exactly at each 1024 boundary', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
    expect(formatBytes(1024 ** 5)).toBe('1.0 PB');
  });

  test('keeps one decimal below 100 and drops it above', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10.0 KB');
    expect(formatBytes(99 * 1024)).toBe('99.0 KB');
    expect(formatBytes(100 * 1024)).toBe('100 KB');
    expect(formatBytes(1023 * 1024)).toBe('1023 KB');
  });

  test('stops at PB instead of inventing a unit', () => {
    expect(formatBytes(1024 ** 6)).toBe('1024 PB');
    expect(formatBytes(2 * 1024 ** 5)).toBe('2.0 PB');
  });

  test('an explicit precision overrides the heuristic', () => {
    expect(formatBytes(1536, 3)).toBe('1.500 KB');
    expect(formatBytes(1536, 0)).toBe('2 KB');
    expect(formatBytes(1024 ** 3, 2)).toBe('1.00 GB');
  });

  test('refuses nonsense input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(-1024)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatSizeColumn', () => {
  test('right-aligns by dropping the decimal above 10 units', () => {
    expect(formatSizeColumn(0)).toBe('0');
    expect(formatSizeColumn(1023)).toBe('1023');
    expect(formatSizeColumn(1024)).toBe('1.0 KB');
    expect(formatSizeColumn(1536)).toBe('1.5 KB');
    expect(formatSizeColumn(10 * 1024)).toBe('10 KB');
    expect(formatSizeColumn(1023 * 1024)).toBe('1023 KB');
    expect(formatSizeColumn(1024 ** 3)).toBe('1.0 GB');
    expect(formatSizeColumn(1024 ** 6)).toBe('1024 PB');
  });

  test('negative sizes render as a dash', () => {
    expect(formatSizeColumn(-1)).toBe('—');
  });
});

describe('formatDate', () => {
  test('renders `DD Mon HH:MM` independent of locale', () => {
    expect(formatDate(localMs(2026, 10, 8, 15, 10))).toBe('08 Oct 15:10');
    expect(formatDate(localMs(2026, 1, 3, 4, 5))).toBe('03 Jan 04:05');
    expect(formatDate(localMs(1999, 12, 31, 23, 59))).toBe('31 Dec 23:59');
    // No year, by design: the column is fixed width.
    expect(formatDate(localMs(2001, 2, 28, 0, 0))).toBe('28 Feb 00:00');
  });

  test('zero-pads day and time but not the month name', () => {
    expect(formatDate(localMs(2026, 9, 1, 9, 7))).toBe('01 Sep 09:07');
  });

  test('covers all twelve month abbreviations', () => {
    MONTHS.forEach((month, index) => {
      expect(formatDate(localMs(2026, index + 1, 15, 12, 0))).toBe(`15 ${month} 12:00`);
    });
  });

  test('a missing timestamp is a dash', () => {
    expect(formatDate(0)).toBe('—');
    expect(formatDate(Number.NaN)).toBe('—');
  });
});

describe('formatFullDate', () => {
  test('renders `DD Mon YYYY, HH:MM` independent of locale', () => {
    expect(formatFullDate(localMs(2026, 10, 8, 15, 10))).toBe('08 Oct 2026, 15:10');
    expect(formatFullDate(localMs(2001, 2, 28, 0, 0))).toBe('28 Feb 2001, 00:00');
    expect(formatFullDate(localMs(2026, 1, 3, 4, 5))).toBe('03 Jan 2026, 04:05');
  });

  test('a missing timestamp is a dash', () => {
    expect(formatFullDate(0)).toBe('—');
  });
});

describe('formatRelative', () => {
  // Only `Date` is faked; promise scheduling keeps using real timers.
  const NOW = localMs(2026, 6, 15, 12, 0);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const ago = (deltaMs: number): string => formatRelative(NOW - deltaMs);
  const SEC = 1_000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  test('a missing timestamp is a dash', () => {
    expect(formatRelative(0)).toBe('—');
  });

  test('the first 45 seconds are "just now", including small clock skew', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(SEC)).toBe('just now');
    expect(ago(44 * SEC)).toBe('just now');
    expect(ago(44_999)).toBe('just now');
    // A timestamp slightly in the future must not produce a negative age.
    expect(formatRelative(NOW + 60 * SEC)).toBe('just now');
  });

  test('minutes bucket up to 59', () => {
    expect(ago(45_000)).toBe('1 min ago');
    expect(ago(MIN)).toBe('1 min ago');
    expect(ago(4 * MIN)).toBe('4 min ago');
    expect(ago(59 * MIN)).toBe('59 min ago');
  });

  test('hours bucket up to 23', () => {
    expect(ago(HOUR)).toBe('1 h ago');
    expect(ago(3 * HOUR)).toBe('3 h ago');
    expect(ago(23 * HOUR)).toBe('23 h ago');
  });

  test('days bucket up to 29', () => {
    expect(ago(DAY)).toBe('1 d ago');
    expect(ago(5 * DAY)).toBe('5 d ago');
    expect(ago(29 * DAY)).toBe('29 d ago');
  });

  test('months bucket up to 11', () => {
    expect(ago(30 * DAY)).toBe('1 mo ago');
    expect(ago(330 * DAY)).toBe('11 mo ago');
  });

  test('a year and beyond', () => {
    expect(ago(365 * DAY)).toBe('1 y ago');
    expect(ago(800 * DAY)).toBe('2 y ago');
    expect(ago(3650 * DAY)).toBe('10 y ago');
  });
});

describe('formatSpeed', () => {
  test('appends /s to a one-decimal size', () => {
    expect(formatSpeed(1024)).toBe('1.0 KB/s');
    expect(formatSpeed(1536)).toBe('1.5 KB/s');
    expect(formatSpeed(512 * 1024)).toBe('512.0 KB/s');
    expect(formatSpeed(3.5 * 1024 * 1024)).toBe('3.5 MB/s');
  });

  test('sub-KiB rates keep their integer form (precision is ignored there)', () => {
    expect(formatSpeed(100)).toBe('100 B/s');
    expect(formatSpeed(1)).toBe('1 B/s');
  });

  test('zero, negative and non-finite rates are a dash', () => {
    expect(formatSpeed(0)).toBe('—');
    expect(formatSpeed(-1)).toBe('—');
    expect(formatSpeed(Number.NaN)).toBe('—');
    expect(formatSpeed(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatEta', () => {
  test('is empty when there is nothing to estimate', () => {
    expect(formatEta(0, 100)).toBe('');
    expect(formatEta(-5, 100)).toBe('');
    expect(formatEta(100, 0)).toBe('');
    expect(formatEta(100, -1)).toBe('');
  });

  test('rounds seconds up to at least one', () => {
    expect(formatEta(10, 1)).toBe('~10 s left');
    expect(formatEta(1, 10)).toBe('~1 s left');
    expect(formatEta(30, 10)).toBe('~3 s left');
    expect(formatEta(59, 1)).toBe('~59 s left');
  });

  test('switches to minutes at 60 seconds', () => {
    expect(formatEta(60, 1)).toBe('~1 min left');
    expect(formatEta(90, 1)).toBe('~2 min left');
    expect(formatEta(600, 1)).toBe('~10 min left');
  });
});

describe('formatPercent', () => {
  test('a zero or negative total is 0%, never NaN', () => {
    expect(formatPercent(0, 0)).toBe(0);
    expect(formatPercent(5, 0)).toBe(0);
    expect(formatPercent(5, -1)).toBe(0);
  });

  test('scales to 0..100', () => {
    expect(formatPercent(0, 10)).toBe(0);
    expect(formatPercent(1, 4)).toBe(25);
    expect(formatPercent(1, 2)).toBe(50);
    expect(formatPercent(10, 10)).toBe(100);
    expect(formatPercent(1, 3)).toBeCloseTo(33.3333, 3);
  });

  test('clamps overshoot and negative progress', () => {
    expect(formatPercent(11, 10)).toBe(100);
    expect(formatPercent(-1, 10)).toBe(0);
  });
});

describe('modeToText', () => {
  test('renders the file-type character for every type bit', () => {
    expect(modeToText(0o100644)).toBe('-rw-r--r--');
    expect(modeToText(0o040755)).toBe('drwxr-xr-x');
    expect(modeToText(0o120777)).toBe('lrwxrwxrwx');
    expect(modeToText(0o020644)).toBe('crw-r--r--');
    expect(modeToText(0o060644)).toBe('brw-r--r--');
    expect(modeToText(0o010644)).toBe('prw-r--r--');
    expect(modeToText(0o140644)).toBe('srw-r--r--');
    // No type bits at all is still a plain file.
    expect(modeToText(0)).toBe('----------');
  });

  test('setuid replaces the owner execute bit with s/S', () => {
    expect(modeToText(0o104755)).toBe('-rwsr-xr-x');
    expect(modeToText(0o104644)).toBe('-rwSr--r--');
  });

  test('setgid replaces the group execute bit with s/S', () => {
    expect(modeToText(0o102755)).toBe('-rwxr-sr-x');
    expect(modeToText(0o102744)).toBe('-rwxr-Sr--');
  });

  test('the sticky bit replaces the other execute bit with t/T', () => {
    expect(modeToText(0o041777)).toBe('drwxrwxrwt');
    expect(modeToText(0o041776)).toBe('drwxrwxrwT');
  });

  test('setuid, setgid and sticky can be present at once', () => {
    expect(modeToText(0o107755)).toBe('-rwsr-sr-t');
    // Without a group/other execute bit the letters degrade to upper case.
    expect(modeToText(0o107744)).toBe('-rwsr-Sr-T');
  });

  test('non-finite modes degrade to an all-dash string', () => {
    expect(modeToText(Number.NaN)).toBe('----------');
    expect(modeToText(Number.POSITIVE_INFINITY)).toBe('----------');
    expect(modeToText(Number.NEGATIVE_INFINITY)).toBe('----------');
  });
});

describe('modeToOctal', () => {
  test('drops the type bits and keeps the permission nibbles', () => {
    expect(modeToOctal(0o100644)).toBe('644');
    expect(modeToOctal(0o040755)).toBe('755');
    expect(modeToOctal(0o120777)).toBe('777');
    expect(modeToOctal(0o100600)).toBe('600');
  });

  test('keeps the setuid / setgid / sticky nibble', () => {
    expect(modeToOctal(0o104755)).toBe('4755');
    expect(modeToOctal(0o102755)).toBe('2755');
    expect(modeToOctal(0o041777)).toBe('1777');
    expect(modeToOctal(0o107755)).toBe('7755');
  });

  test('is always at least three digits', () => {
    expect(modeToOctal(0)).toBe('000');
    expect(modeToOctal(0o100000)).toBe('000');
  });
});

describe('extensionOf', () => {
  test('returns the lower-cased text after the last dot', () => {
    expect(extensionOf('file.txt')).toBe('txt');
    expect(extensionOf('FILE.TXT')).toBe('txt');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('a.b.c')).toBe('c');
    expect(extensionOf('.env.local')).toBe('local');
  });

  test('is empty when there is no usable extension', () => {
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('')).toBe('');
    expect(extensionOf('.')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
    // A leading dot marks a hidden file, not an extension.
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('.bashrc')).toBe('');
  });
});

describe('describeKind', () => {
  test('names directories and symlinks by kind', () => {
    expect(describeKind('whatever.zip', 'directory')).toBe('Folder');
    expect(describeKind('notes.txt', 'symlink')).toBe('Symbolic link');
  });

  test('names files by their upper-cased extension', () => {
    expect(describeKind('a.txt', 'file')).toBe('TXT file');
    expect(describeKind('a.TXT', 'file')).toBe('TXT file');
    expect(describeKind('a.bin', 'other')).toBe('BIN file');
  });

  test('falls back to "File" when there is no extension', () => {
    expect(describeKind('noext', 'file')).toBe('File');
    expect(describeKind('.bashrc', 'file')).toBe('File');
  });
});

describe('formatCount', () => {
  test('singular for one, plural otherwise', () => {
    expect(formatCount(0, 'file')).toBe('0 files');
    expect(formatCount(1, 'file')).toBe('1 file');
    expect(formatCount(2, 'file')).toBe('2 files');
    expect(formatCount(1, 'entry', 'entries')).toBe('1 entry');
    expect(formatCount(3, 'entry', 'entries')).toBe('3 entries');
    expect(formatCount(1, 'box', 'boxes')).toBe('1 box');
    expect(formatCount(2, 'box', 'boxes')).toBe('2 boxes');
  });
});
