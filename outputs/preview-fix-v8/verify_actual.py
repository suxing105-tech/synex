import sys,shutil,json,hashlib
from pathlib import Path
from PIL import Image,ImageOps,ImageChops,ImageStat
sys.path.insert(0,str(Path('backend').resolve()))
from app import config
from app.thumbnails import generate_preview
root=Path('outputs/preview-fix-v8/actual-image-check').resolve()
config.DEFAULT_DATA_DIR=root
legacy=config.previews_dir()/'171_max1024.webp'
shutil.copyfile(Path.home()/'AppData/Roaming/com.suxing.gallery/data/previews/171_max1024.webp',legacy)
source=Path(r'C:/Users/Administrator/Desktop/人物三视图.jpg')
before=hashlib.sha256(source.read_bytes()).hexdigest()
preview=generate_preview(source,171,1024)
with Image.open(source) as im:
 expected=ImageOps.exif_transpose(im).convert('RGB');expected.thumbnail((1024,1024),Image.Resampling.LANCZOS)
 with Image.open(preview) as actual:
  assert actual.size==expected.size
  error=sum(ImageStat.Stat(ImageChops.difference(actual.convert('RGB'),expected)).mean)/3
  assert error<12
assert hashlib.sha256(source.read_bytes()).hexdigest()==before
shutil.copyfile(preview,root/'correct-preview.webp')
(root/'verification.json').write_text(json.dumps({'source_sha256':before,'preview_size':expected.size,'mean_pixel_error':error,'legacy_ignored':preview!=legacy,'source_unchanged':True},indent=2),encoding='utf-8')
print(root/'correct-preview.webp')
