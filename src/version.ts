/**
 * Package version. The release pipeline (release.yml) stamps the git-tag
 * version over this constant at build time; the committed value stays a
 * sentinel so source checkouts are recognizable.
 */
export const VERSION = "0.0.0-dev"
