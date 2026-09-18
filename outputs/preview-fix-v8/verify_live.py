import json,time,io,hashlib
from pathlib import Path
from urllib.request import urlopen
from PIL import Image,ImageOps,ImageChops,ImageStat
base='http://127.0.0.1:8765'
for attempt in range(100):
 try:
  with urlopen(base+'/api/images?limit=2000',timeout=2) as response: items=json.load(response)['items']
  target=next(item for item in items if item['filename']=='人物三视图_1.jpg')
  if 'v=2-' in target['original_url']: break
 except (OSError,ValueError,StopIteration): pass
 time.sleep(.25)
else: raise AssertionError('新版后台或目标图片未就绪')
with urlopen(base+target['original_url'],timeout=10) as response:
 data=response.read();cache=response.headers['Cache-Control']
Path('outputs/preview-fix-v8/live-preview.webp').write_bytes(data)
with Image.open(r'C:/Users/Administrator/Desktop/人物三视图.jpg') as original:
 reference=ImageOps.exif_transpose(original).convert('RGB');reference.thumbnail((1024,1024),Image.Resampling.LANCZOS)
with Image.open(io.BytesIO(data)) as preview:
 assert preview.size==reference.size
 error=sum(ImageStat.Stat(ImageChops.difference(preview.convert('RGB'),reference)).mean)/3
 assert error<12
result={'id':target['id'],'filename':target['filename'],'preview_size':reference.size,'mean_pixel_error':error,'cache_control':cache,'passed':True}
Path('outputs/preview-fix-v8/live-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print('Live application preview matches supplied image.')
