#!/usr/bin/env python3
"""Builds a .vsix package from extension source without external npm/vsce dependencies."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path


def build_vsix() -> Path:
    repo_root = Path(__file__).resolve().parent.parent
    pkg_file = repo_root / "package.json"

    with open(pkg_file, "r", encoding="utf-8") as f:
        pkg = json.load(f)

    name = pkg.get("name", "antigravity-token-telemetry")
    version = pkg.get("version", "1.0.0")
    publisher = pkg.get("publisher", "antigravity")
    display_name = pkg.get("displayName", "Antigravity Token Telemetry")
    desc = pkg.get("description", "Antigravity token and cache telemetry for VS Code.")

    dist_dir = repo_root / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)

    # Clean up older .vsix files so only the active version is retained
    for old_vsix in dist_dir.glob("*.vsix"):
        if old_vsix.name != f"{name}-{version}.vsix":
            try:
                old_vsix.unlink()
            except OSError:
                pass

    vsix_path = dist_dir / f"{name}-{version}.vsix"

    content_types = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
"""

    manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Id="{name}" Version="{version}" Publisher="{publisher}"/>
    <DisplayName>{display_name}</DisplayName>
    <Description>{desc}</Description>
    <Categories>Other</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
  </Assets>
</PackageManifest>
"""

    files_to_pack = [
        ("package.json", "extension/package.json"),
        ("extension.js", "extension/extension.js"),
        ("README.md", "extension/README.md"),
    ]
    if (repo_root / "LICENSE").exists():
        files_to_pack.append(("LICENSE", "extension/LICENSE"))

    with zipfile.ZipFile(vsix_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("extension.vsixmanifest", manifest)

        for src, dest in files_to_pack:
            src_path = repo_root / src
            if src_path.exists():
                z.write(src_path, dest)

    print(f"✅ Successfully built: {vsix_path} ({vsix_path.stat().st_size:,} bytes)")
    return vsix_path


if __name__ == "__main__":
    build_vsix()
