from pathlib import Path
import subprocess
base=Path('outputs/update-shutdown-v0.2.3')
commit=subprocess.check_output(['git','-C','outputs/release-v0.2.2/repository','rev-parse','HEAD'],text=True).strip()
s=Path('outputs/release-v0.2.2/publish_release.py').read_text(encoding='utf-8').replace('0.2.2','0.2.3').replace('8e0778d86e5baca3b48426949ead06ec093e2531',commit)
(base/'publish_release.py').write_text(s,encoding='utf-8')
s=Path('outputs/release-v0.2.2/verify_public.py').read_text(encoding='utf-8').replace('0.2.2','0.2.3')
(base/'verify_public.py').write_text(s,encoding='utf-8')
