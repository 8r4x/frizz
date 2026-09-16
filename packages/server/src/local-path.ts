// URL pathnames keep a slash before a Windows drive. Only the server knows whether that
// slash is URL syntax or part of a valid POSIX path such as /C:/docs/plan.md.
export function normalizeLocalPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.replace(/^\/([a-zA-Z]:[\\/])/, "$1") : path
}
