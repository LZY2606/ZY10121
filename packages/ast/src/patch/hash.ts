/**
 * Dependency-free FNV-1a 64-bit content fingerprint used for patch
 * preconditions.
 *
 * The digest is intended for change detection only; it is not a cryptographic
 * hash.
 *
 * @param input The text to fingerprint.
 * @returns Lower-case hex digest (up to 16 digits).
 * @group Patch
 */
export function contentHash(input: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  let hash = FNV_OFFSET;
  const mixByte = (byte: number): void => {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  };
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    // Combine UTF-16 surrogate pairs into a single astral code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    // Mix the UTF-8 encoding of the code point.
    if (code < 0x80) {
      mixByte(code);
    } else if (code < 0x800) {
      mixByte(0xc0 | (code >> 6));
      mixByte(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      mixByte(0xe0 | (code >> 12));
      mixByte(0x80 | ((code >> 6) & 0x3f));
      mixByte(0x80 | (code & 0x3f));
    } else {
      mixByte(0xf0 | (code >> 18));
      mixByte(0x80 | ((code >> 12) & 0x3f));
      mixByte(0x80 | ((code >> 6) & 0x3f));
      mixByte(0x80 | (code & 0x3f));
    }
  }
  return hash.toString(16).padStart(16, '0');
}
