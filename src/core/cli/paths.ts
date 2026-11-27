const unsafeCharacters = /[<>:"|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const deviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)[0-9¹²³])$/iu;

export function isSafeFileName(value: string): boolean {
  return value !== '' && !/[\\/]/.test(value) && !unsafeCharacters.test(value) &&
    !/[ .]$/.test(value) && !deviceName.test(value.split('.')[0].trimEnd());
}

/** Accept local Windows and POSIX paths, with identical checks on their components. */
export function isSafeLocalPath(value: string): boolean {
  if (/^[\\/]{2}/.test(value)) return false;
  const local = value.replace(/^[a-z]:[\\/]/i, '');
  const parts = local.split(/[\\/]/).filter(part => part !== '' && part !== '.');
  return parts.length > 0 && parts.every(isSafeFileName);
}
