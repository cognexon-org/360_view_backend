from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .exports import _raster
from ..storage import get_bytes, put_bytes


def _blender_script(input_glb: str, output_path: str, settings_path: str) -> str:
    return f'''
import bpy, json, math
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath={input_glb!r})
settings=json.load(open({settings_path!r}, 'r'))
objects=[o for o in bpy.context.scene.objects if o.type=='MESH']
if not objects: raise RuntimeError('No mesh objects in GLB')
mins=Vector((1e9,1e9,1e9)); maxs=Vector((-1e9,-1e9,-1e9))
for obj in objects:
  for corner in obj.bound_box:
    world=obj.matrix_world @ Vector(corner)
    mins.x=min(mins.x,world.x); mins.y=min(mins.y,world.y); mins.z=min(mins.z,world.z)
    maxs.x=max(maxs.x,world.x); maxs.y=max(maxs.y,world.y); maxs.z=max(maxs.z,world.z)
center=(mins+maxs)*0.5; extent=max((maxs-mins).length, 2.0)
world=bpy.data.worlds.new('World'); bpy.context.scene.world=world; world.use_nodes=True
world.node_tree.nodes['Background'].inputs['Color'].default_value=(0.055,0.065,0.085,1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value=0.6
cam_data=bpy.data.cameras.new('Camera'); cam=bpy.data.objects.new('Camera',cam_data); bpy.context.collection.objects.link(cam); bpy.context.scene.camera=cam
camera=settings.get('camera') or {{}}
cam.location=(camera.get('x', center.x+extent*0.8),camera.get('y',center.y-extent*0.9),camera.get('z',maxs.z+extent*0.6))
def look_at(obj, point): obj.rotation_euler=(Vector(point)-obj.location).to_track_quat('-Z','Y').to_euler()
look_at(cam, center); cam.data.lens=float(camera.get('lensMm',42))
for name,energy,size,location in [('Key',1400,5,(center.x+extent,center.y-extent,maxs.z+extent)),('Fill',700,4,(center.x-extent,center.y-extent*0.3,maxs.z+extent*0.5))]:
  data=bpy.data.lights.new(name,'AREA'); data.energy=energy; data.shape='DISK'; data.size=size
  obj=bpy.data.objects.new(name,data); bpy.context.collection.objects.link(obj); obj.location=location; look_at(obj,center)
scene=bpy.context.scene
try: scene.render.engine='BLENDER_EEVEE_NEXT'
except Exception: scene.render.engine='BLENDER_EEVEE'
scene.render.resolution_x=int(settings.get('width',1600)); scene.render.resolution_y=int(settings.get('height',1000)); scene.render.resolution_percentage=100
scene.render.film_transparent=False
try:
  scene.view_settings.view_transform='AgX'; scene.view_settings.look='AgX - Medium High Contrast'
except Exception: pass
mode=str(settings.get('renderMode','STILL')).upper()
if mode=='PANORAMA':
  cam.data.type='PANO'; cam.data.cycles.panorama_type='EQUIRECTANGULAR'
  cam.location=(camera.get('x',center.x),camera.get('y',center.y),camera.get('z',max(mins.z+1.55, center.z)))
  scene.render.resolution_x=int(settings.get('width',4096)); scene.render.resolution_y=int(settings.get('height',2048))
  scene.render.image_settings.file_format='PNG'; scene.render.filepath={output_path!r}; bpy.ops.render.render(write_still=True)
elif mode=='WALKTHROUGH':
  scene.render.image_settings.file_format='FFMPEG'; scene.render.ffmpeg.format='MPEG4'; scene.render.ffmpeg.codec='H264'; scene.render.ffmpeg.constant_rate_factor='MEDIUM'
  scene.render.fps=int(settings.get('fps',30)); scene.render.resolution_x=int(settings.get('width',1280)); scene.render.resolution_y=int(settings.get('height',720))
  path=settings.get('path') or []
  if len(path)<2:
    path=[]
    for i in range(9):
      a=2*math.pi*i/8; path.append({{'x':center.x+math.cos(a)*extent*0.7,'y':center.y+math.sin(a)*extent*0.7,'z':maxs.z*0.55+0.8,'target':[center.x,center.y,center.z]}})
  frames_per=int(settings.get('framesPerSegment',45)); scene.frame_start=1; scene.frame_end=1+(len(path)-1)*frames_per
  for i,p in enumerate(path):
    frame=1+i*frames_per; cam.location=(float(p['x']),float(p['y']),float(p['z'])); look_at(cam,p.get('target',center)); cam.keyframe_insert('location',frame=frame); cam.keyframe_insert('rotation_euler',frame=frame)
  scene.render.filepath={output_path!r}; bpy.ops.render.render(animation=True)
else:
  scene.render.image_settings.file_format='PNG'; scene.render.filepath={output_path!r}; bpy.ops.render.render(write_still=True)
'''


def render_scene(payload: dict[str, Any]) -> dict[str, Any]:
    output_bucket=str(payload['outputBucket']); output_key=str(payload['outputKey'])
    model=payload.get('model') if isinstance(payload.get('model'),dict) else {}
    settings=payload.get('settings') if isinstance(payload.get('settings'),dict) else {}
    render_mode=str(settings.get('renderMode','STILL')).upper()
    blender=shutil.which(str(payload.get('blenderExecutable') or os.getenv('BLENDER_EXECUTABLE','blender')))
    source=payload.get('sourceGlb') if isinstance(payload.get('sourceGlb'),dict) else None
    mime='video/mp4' if render_mode=='WALKTHROUGH' else 'image/png'
    data: bytes; mode='FLOORPLAN_FALLBACK'
    if blender and source and source.get('bucket') and source.get('objectKey'):
        with tempfile.TemporaryDirectory(prefix='pt360-render-') as tmp:
            tmp_path=Path(tmp); glb=tmp_path/'scene.glb'; out=tmp_path/('walkthrough.mp4' if render_mode=='WALKTHROUGH' else 'render.png'); settings_file=tmp_path/'settings.json'; script=tmp_path/'render.py'
            glb.write_bytes(get_bytes(str(source['bucket']),str(source['objectKey'])))
            settings_file.write_text(json.dumps(settings)); script.write_text(_blender_script(str(glb),str(out),str(settings_file)))
            proc=subprocess.run([blender,'--background','--python',str(script)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=int(settings.get('timeoutSeconds',900)))
            if proc.returncode==0 and out.exists():
                data=out.read_bytes(); mode='BLENDER_EEVEE'
            elif render_mode=='WALKTHROUGH':
                raise RuntimeError('Blender walkthrough render failed: '+proc.stdout.decode('utf-8',errors='ignore')[-3000:])
            else:
                data=_raster(model,'PNG')
    elif render_mode=='WALKTHROUGH':
        raise RuntimeError('Blender is required for walkthrough MP4 rendering')
    else:
        data=_raster(model,'PNG')
    put_bytes(output_bucket,output_key,data,mime)
    return {'outputBucket':output_bucket,'outputKey':output_key,'mimeType':mime,'sizeBytes':len(data),'renderMode':mode,'requestedRenderMode':render_mode,'settings':settings}
