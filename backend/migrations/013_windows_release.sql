-- Signed Windows installers (MSI), one row per version and architecture. The Windows service reads the newest for
-- its architecture and updates itself; the site's download page links the same files. Global, read through
-- duckling_system only.
CREATE TABLE windows_release (
  version text NOT NULL,
  arch text NOT NULL CHECK (arch IN ('x64', 'arm64')),
  file_key text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (arch, version)
);
