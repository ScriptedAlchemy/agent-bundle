export const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

/** A token that is an absolute, home-relative, drive-letter, or UNC path, or a `file:` URL. */
export const pathLikeText = /(?:^|[\s"'`([=:,])(?:\/[^\s/]+){2,}|~[\\/]|file:|(?:^|[^A-Za-z0-9])[A-Za-z]:|\\\\/u;
