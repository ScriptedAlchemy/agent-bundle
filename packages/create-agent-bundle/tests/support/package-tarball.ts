import { gzipSync } from 'node:zlib';

const tarBlockSize = 512;
const tarChecksumOffset = 148;
const tarChecksumLength = 8;
const tarModeOffset = 100;

const writeOctalField = (header: Buffer, value: number, offset: number, length: number): void => {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, 'ascii');
};

const applyHeaderChecksum = (header: Buffer): void => {
  header.fill(0x20, tarChecksumOffset, tarChecksumOffset + tarChecksumLength);
  let sum = 0;
  for (let index = 0; index < tarBlockSize; index += 1) sum += header[index]!;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, tarChecksumOffset, 'ascii');
};

/**
 * The smallest archive `localTarballPackageName` accepts: one ustar entry for
 * `package/package.json` naming the package, then the end-of-archive blocks.
 */
export const packageTarArchive = (name: string): Buffer => {
  const manifest = Buffer.from(JSON.stringify({ name }));
  const archive = Buffer.alloc(
    tarBlockSize + Math.ceil(manifest.length / tarBlockSize) * tarBlockSize + tarBlockSize * 2,
  );
  const header = archive.subarray(0, tarBlockSize);
  header.write('package/package.json', 0, 'utf8');
  writeOctalField(header, 0o644, tarModeOffset, 8);
  writeOctalField(header, 0, 108, 8);
  writeOctalField(header, 0, 116, 8);
  writeOctalField(header, manifest.length, 124, 12);
  writeOctalField(header, 0, 136, 12);
  header.write('0', 156, 'ascii');
  header.write('ustar', 257, 'ascii');
  header.write('00', 263, 'ascii');
  applyHeaderChecksum(header);
  manifest.copy(archive, tarBlockSize);
  return archive;
};

export const packageTarball = (name: string): Buffer => gzipSync(packageTarArchive(name));

/**
 * A gzip stream that still inflates cleanly, carrying a header whose mode was
 * rewritten without refreshing the checksum. The parser never reads the mode,
 * so only checksum verification can tell this archive from a sound one.
 */
export const tamperedPackageTarball = (name: string): Buffer => {
  const archive = packageTarArchive(name);
  writeOctalField(archive, 0o777, tarModeOffset, 8);
  return gzipSync(archive);
};
