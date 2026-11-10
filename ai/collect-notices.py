"""Copy installed Python dependency license files; no model files are inspected."""
from pathlib import Path
import importlib.metadata as metadata
import hashlib,json,sys,shutil
root=Path(sys.argv[1]).resolve()
root.mkdir(parents=True,exist_ok=True)
entries=[]
for distribution in metadata.distributions():
    name=distribution.metadata["Name"]
    destination=root/name
    destination.mkdir(exist_ok=True)
    copied=[]
    for relative in distribution.files or []:
        upper=relative.name.upper()
        if not (upper.startswith(("LICENSE","LICENCE","COPYING","NOTICE")) or "THIRD_PARTY" in upper or "THIRD-PARTY" in upper):
            continue
        source=Path(distribution.locate_file(relative))
        if not source.is_file() or source.is_symlink():
            continue
        target=hashlib.sha256(str(relative).encode()).hexdigest()[:16]+"-"+source.name
        shutil.copy2(source,destination/target)
        copied.append(name+"/"+target)
    entries.append(dict(name=name,version=distribution.version,license=distribution.metadata.get("License-Expression") or distribution.metadata.get("License",""),files=copied))
(root/"python-notices.json").write_text(json.dumps(entries,ensure_ascii=False,indent=2),encoding="utf-8")
print("Collected notices for",len(entries),"code dependencies. No weights included.")
